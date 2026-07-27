import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import {
  createHarness,
  MASTER_KEY,
  OWNER_URL,
  resetData,
  seedUser,
  type Harness,
} from './helpers.js';

const run = promisify(execFile);
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The roadmap's final Phase 1 acceptance criterion:
 *
 *   docker compose exec api npm run admin -- admin:reset-password
 *
 * recovers a locked-out admin and leaves an audit row.
 *
 * The CLI is run as a real child process, because half of what is being
 * asserted is that it works as a process with no HTTP surface at all.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetData(h.ownerDb);
});

type CliResult = { code: number; stdout: string; stderr: string };

async function admin(...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', 'src/cli/admin.ts', ...args], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: OWNER_URL,
        MIGRATE_DATABASE_URL: OWNER_URL,
        MASTER_KEY,
        LOG_LEVEL: 'silent',
        MIGRATE_ON_START: 'false',
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('admin:reset-password recovers a locked-out admin', () => {
  it('issues a working one-time password and leaves an audit row', async () => {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    // Lock the account the way ten failed attempts would.
    await h.ownerDb.execute(sql`
      update users
      set failed_attempts = 10, locked_until = now() + interval '15 minutes'
      where id = ${adminUser.id}::uuid
    `);

    const locked = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: adminUser.password });
    expect(locked.status).toBe(429);

    const result = await admin('admin:reset-password', '--email', adminUser.email, '--confirm');
    expect(result.code).toBe(0);

    const oneTimePassword = /One-time password:\s*(\S+)/.exec(result.stdout)?.[1];
    expect(oneTimePassword).toBeTruthy();

    // The account is usable again, and the password it prints actually works.
    const recovered = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: oneTimePassword });
    expect(recovered.status).toBe(200);

    const rows = await h.ownerDb.execute<{ action: string; metadata: Record<string, unknown> }>(
      sql`select action, metadata from audit_log where action = 'user.password_reset'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.actor).toBe('system:cli');
    expect(rows[0]!.metadata.command).toBe('admin:reset-password');
    expect(rows[0]!.metadata.osUser).toBeTruthy();
  });

  it('requires --confirm', async () => {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    const result = await admin('admin:reset-password', '--email', adminUser.email);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--confirm/);

    // Nothing happened, so nothing was audited.
    const rows = await h.ownerDb.execute(
      sql`select 1 from audit_log where action = 'user.password_reset'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('prints the target account before acting, so a typo is visible', async () => {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const result = await admin('admin:reset-password', '--email', adminUser.email, '--confirm');

    expect(result.stdout).toContain(adminUser.email);
    expect(result.stdout).toContain('admin');
  });

  it('fails cleanly on an unknown account', async () => {
    const result = await admin(
      'admin:reset-password',
      '--email',
      'nobody@example.org',
      '--confirm',
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/No account found/);
  });
});

describe('admin:create', () => {
  it('creates an admin and prints a one-time password that works', async () => {
    const result = await admin(
      'admin:create',
      '--email',
      'firstadmin@example.org',
      '--name',
      'First Admin',
    );
    expect(result.code).toBe(0);

    const oneTimePassword = /One-time password:\s*(\S+)/.exec(result.stdout)?.[1];
    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: 'firstadmin@example.org', password: oneTimePassword });

    expect(login.status).toBe(200);
    expect(login.body.principal.role).toBe('admin');
    expect(login.body.principal.mustChangePassword).toBe(true);
  });

  it('refuses to create a participant account, which belongs in the app', async () => {
    const result = await admin(
      'admin:create',
      '--email',
      'selfaccess@example.org',
      '--name',
      'Self Access',
      '--role',
      'participant',
    );
    expect(result.code).toBe(1);
  });
});

describe('admin:list', () => {
  it('answers "is there another admin"', async () => {
    await seedUser(h.ownerDb, h.keyRing, { role: 'admin', email: 'one@example.org' });

    const single = await admin('admin:list');
    expect(single.code).toBe(0);
    expect(single.stdout).toContain('one@example.org');
    expect(single.stdout).toMatch(/Only one active admin/);

    await seedUser(h.ownerDb, h.keyRing, { role: 'admin', email: 'two@example.org' });
    const pair = await admin('admin:list');
    expect(pair.stdout).toMatch(/2 active admins/);
  });

  it('says so plainly when there are no admins at all', async () => {
    const result = await admin('admin:list');
    expect(result.stdout).toMatch(/No admin accounts exist/);
  });
});

describe('admin:disable-totp and admin:unlock', () => {
  it('clears two-factor so the user can enrol again', async () => {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    const result = await admin('admin:disable-totp', '--email', adminUser.email, '--confirm');
    expect(result.code).toBe(0);

    const [row] = await h.ownerDb.execute<{ totp_enabled_at: string | null }>(
      sql`select totp_enabled_at from users where id = ${adminUser.id}::uuid`,
    );
    expect(row!.totp_enabled_at).toBeNull();

    const rows = await h.ownerDb.execute(
      sql`select 1 from audit_log where action = 'user.totp_reset'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('clears a lockout', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await h.ownerDb.execute(sql`
      update users set failed_attempts = 10, locked_until = now() + interval '15 minutes'
      where id = ${worker.id}::uuid
    `);

    const result = await admin('admin:unlock', '--email', worker.email);
    expect(result.code).toBe(0);

    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: worker.email, password: worker.password });
    expect(login.status).toBe(200);
  });
});

describe('admin:revoke-sessions', () => {
  it('kills live sessions and flags devices for wipe', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: worker.email, password: worker.password });
    const cookies = login.headers['set-cookie'] as unknown as string[];

    expect((await request(h.app).get('/api/v1/participants').set('Cookie', cookies)).status).toBe(
      200,
    );

    const result = await admin('admin:revoke-sessions', '--email', worker.email, '--confirm');
    expect(result.code).toBe(0);

    expect((await request(h.app).get('/api/v1/participants').set('Cookie', cookies)).status).toBe(
      401,
    );
  });
});

describe('audit:verify', () => {
  it('reports an intact chain and audits the check itself', async () => {
    await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    await admin('admin:list');

    const result = await admin('audit:verify');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Audit chain intact/);

    const rows = await h.ownerDb.execute(
      sql`select 1 from audit_log where action = 'audit.verify'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('exits non-zero and names the bad row when the chain is broken', async () => {
    await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    await admin('admin:list');
    await admin('admin:list');

    await h.ownerDb.execute(sql`alter table audit_log disable trigger audit_log_no_update`);
    await h.ownerDb.execute(
      sql`update audit_log set action = 'covered up' where id = (select min(id) from audit_log)`,
    );
    await h.ownerDb.execute(sql`alter table audit_log enable trigger audit_log_no_update`);

    const result = await admin('audit:verify');
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/AUDIT CHAIN BROKEN/);
    expect(result.stdout).toMatch(/possible tampering/);
  });
});

describe('the CLI cannot reach participant data', () => {
  it('has no command that reads a participant', async () => {
    const help = await admin('help');
    expect(help.stdout).not.toMatch(/participant:/);
    expect(help.stdout).toMatch(/cannot read or export\s+participant data/);
  });

  it('rejects an unknown command rather than guessing', async () => {
    const result = await admin('participant:export');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown command/);
  });
});
