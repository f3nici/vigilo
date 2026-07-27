import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import {
  assign,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  type Harness,
} from './helpers.js';
import { recordAudit, verifyAuditChain } from '../src/services/audit.js';

/**
 * The roadmap's other Phase 1 acceptance criterion: the audit log rejects
 * UPDATE and DELETE from the application role.
 *
 * These tests run against the same restricted connection the API serves with,
 * so they exercise the real grants rather than a simulation of them.
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

describe('the audit log is append-only for the application role', () => {
  beforeEach(async () => {
    await recordAudit(h.db, {
      action: 'auth.login',
      actor: { userId: null, ip: '127.0.0.1', deviceId: null },
      metadata: { seed: true },
    });
  });

  it('allows INSERT', async () => {
    const rows = await h.db.execute<{ count: string }>(
      sql`select count(*)::text as count from audit_log`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('allows SELECT, because an access audit has to be readable', async () => {
    const rows = await h.db.execute(sql`select action from audit_log`);
    expect(rows).toHaveLength(1);
  });

  it('refuses UPDATE', async () => {
    await expect(h.db.execute(sql`update audit_log set action = 'auth.logout'`)).rejects.toThrow();
  });

  it('refuses DELETE', async () => {
    await expect(h.db.execute(sql`delete from audit_log`)).rejects.toThrow();
  });

  it('refuses TRUNCATE', async () => {
    await expect(h.db.execute(sql`truncate table audit_log`)).rejects.toThrow();
  });

  it('leaves the row intact after a refused UPDATE', async () => {
    await h.db.execute(sql`update audit_log set action = 'tampered'`).catch(() => undefined);

    const rows = await h.ownerDb.execute<{ action: string }>(sql`select action from audit_log`);
    expect(rows[0]!.action).toBe('auth.login');
  });

  it('refuses UPDATE even for the owner, via the trigger', async () => {
    // Defence in depth: the grants stop the app, the trigger stops everyone.
    // Nothing in the product ever legitimately rewrites an audit row.
    await expect(h.ownerDb.execute(sql`update audit_log set action = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuses DELETE even for the owner, via the trigger', async () => {
    await expect(h.ownerDb.execute(sql`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('the hash chain', () => {
  it('verifies over rows written through the service', async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordAudit(h.db, {
        action: `test.action_${i}`,
        actor: { userId: null, ip: null, deviceId: null },
        metadata: { i },
      });
    }

    const result = await verifyAuditChain(h.db);
    expect(result).toEqual({ ok: true, rowsChecked: 5 });
  });

  it('detects a row altered behind the trigger', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordAudit(h.db, {
        action: `test.action_${i}`,
        actor: { userId: null, ip: null, deviceId: null },
      });
    }

    // Simulate tampering at the storage layer, past both the grants and the
    // trigger, which is exactly what the chain exists to catch.
    await h.ownerDb.execute(sql`alter table audit_log disable trigger audit_log_no_update`);
    await h.ownerDb.execute(
      sql`update audit_log set action = 'covered up' where id = (select min(id) from audit_log)`,
    );
    await h.ownerDb.execute(sql`alter table audit_log enable trigger audit_log_no_update`);

    const result = await verifyAuditChain(h.db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('hash_mismatch');
  });
});

describe('what gets audited', () => {
  it('records a successful sign-in', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    const rows = await h.ownerDb.execute<{ action: string; entity_id: string | null }>(
      sql`select action, entity_id from audit_log order by id`,
    );
    expect(rows.map((r) => r.action)).toContain('auth.login');
  });

  it('records a failed sign-in without revealing which part was wrong', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not the right one at all' });

    const rows = await h.ownerDb.execute<{ action: string; metadata: Record<string, unknown> }>(
      sql`select action, metadata from audit_log order by id`,
    );
    expect(rows.map((r) => r.action)).toContain('auth.login_failed');
    // The password never appears anywhere in the audit metadata.
    expect(JSON.stringify(rows)).not.toContain('not the right one');
  });

  it('records a participant view, batched per 15 minutes', async () => {
    const participantId = await seedParticipant(h.ownerDb, h.keyRing);
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, participantId);

    const { cookies } = await signIn(h, worker);

    // Three reads in the same window should produce one audit row.
    for (let i = 0; i < 3; i += 1) {
      await request(h.app).get(`/api/v1/participants/${participantId}`).set('Cookie', cookies);
    }

    const rows = await h.ownerDb.execute<{ count: string }>(
      sql`select count(*)::text as count from audit_log where action = 'participant.view'`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('keeps participant names out of audit metadata by never accepting them', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ email: 'newperson@example.org', displayName: 'Jo Smith', role: 'worker' });

    const rows = await h.ownerDb.execute<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_log where action = 'user.create'`,
    );
    expect(rows).toHaveLength(1);
    const metadata = JSON.stringify(rows[0]!.metadata);
    expect(metadata).not.toContain('Jo Smith');
    expect(metadata).not.toContain('newperson@example.org');
  });
});
