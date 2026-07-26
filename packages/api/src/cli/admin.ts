import { eq, sql } from 'drizzle-orm';
import { userInfo } from 'node:os';
import { emailSchema, type Role } from '@vigilo/shared';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { migrationsPending } from '../db/migrate.js';
import { KeyRing } from '../crypto/keys.js';
import { users } from '../db/schema.js';
import { generateOneTimePassword, hashPassword } from '../crypto/passwords.js';
import { recordAudit, verifyAuditChain, type AuditActor } from '../services/audit.js';
import { revokeAllForUser } from '../services/auth.js';
import { countActiveAdmins } from '../services/users.js';
import { requestDeviceWipe } from '../services/devices.js';

/**
 * The break-glass admin CLI (doc 01 §10.1, doc 02 §9, doc 07 §3).
 *
 * With no email in the system, this is the only account recovery path that
 * exists. Its security properties are not optional:
 *
 * - Shell access to the host is the boundary. No HTTP surface, no listener.
 * - Every invocation writes to the audit log, and it cannot suppress its own
 *   entry. Break-glass that leaves no trace is a backdoor.
 * - It cannot read, decrypt or export participant data. Accounts, sessions and
 *   the audit chain only.
 * - One-time passwords print once to stdout and are never persisted or logged.
 * - It refuses to run against a database with pending migrations.
 * - Destructive commands require --confirm and print the target first.
 */

class CliError extends Error {}

/** stdout is the operator's terminal. This is the one place printing is right. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

type Args = {
  command: string;
  flags: Map<string, string | true>;
};

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (!command) throw new CliError('No command given.');

  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new CliError(`Unexpected argument: ${token}`);

    const eq = token.indexOf('=');
    if (eq > 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(token.slice(2), next);
      i += 1;
    } else {
      flags.set(token.slice(2), true);
    }
  }

  return { command, flags };
}

function requireFlag(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`--${name} is required.`);
  }
  return value;
}

/**
 * The audit actor for every CLI invocation. There is no user id because the
 * operator is not an account; the OS user is recorded instead.
 */
function cliActor(): AuditActor {
  return { userId: null, ip: null, deviceId: null };
}

function cliMetadata(
  command: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  let osUser = 'unknown';
  try {
    osUser = userInfo().username;
  } catch {
    // Container without a passwd entry for the uid. Not fatal.
  }
  return { actor: 'system:cli', osUser, command, ...extra };
}

async function findUser(db: Database, email: string) {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw new CliError('That is not a valid email address.');

  const [user] = await db.select().from(users).where(eq(users.email, parsed.data)).limit(1);
  if (!user) throw new CliError(`No account found for ${parsed.data}.`);
  return user;
}

/** Printed before anything destructive, so the operator sees the target. */
function describe(user: { email: string; role: string; status: string }): void {
  out(`  Account: ${user.email}`);
  out(`  Role:    ${user.role}`);
  out(`  Status:  ${user.status}`);
}

function requireConfirm(args: Args, what: string): void {
  if (args.flags.get('confirm') !== true) {
    throw new CliError(`Add --confirm to ${what}.`);
  }
}

const USAGE = `
Vigilo admin CLI. Run on the host, inside the API container:

  docker compose exec api npm run admin -- <command> [flags]

Commands:
  admin:create           --email <email> --name <name> [--role admin|team_leader|nurse|worker]
  admin:reset-password   --email <email> --confirm
  admin:disable-totp     --email <email> --confirm
  admin:unlock           --email <email>
  admin:list
  admin:revoke-sessions  --email <email> --confirm
  audit:verify

Every invocation is written to the audit log. This tool cannot read or export
participant data.
`.trim();

async function run(db: Database, args: Args): Promise<number> {
  switch (args.command) {
    case 'admin:create': {
      const email = requireFlag(args, 'email');
      const name = requireFlag(args, 'name');
      const roleFlag = args.flags.get('role');
      const role = (typeof roleFlag === 'string' ? roleFlag : 'admin') as Role;

      if (!['admin', 'team_leader', 'nurse', 'worker'].includes(role)) {
        throw new CliError(
          'Role must be admin, team_leader, nurse or worker. Participant accounts are created in the app.',
        );
      }

      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) throw new CliError('That is not a valid email address.');

      const oneTimePassword = generateOneTimePassword();
      const [created] = await db
        .insert(users)
        .values({
          email: parsed.data,
          displayName: name,
          role,
          passwordHash: await hashPassword(oneTimePassword),
          mustChangePassword: true,
        })
        .returning();

      await recordAudit(db, {
        action: 'user.create',
        actor: cliActor(),
        entityType: 'user',
        entityId: created!.id,
        metadata: cliMetadata(args.command, { role, target: parsed.data }),
      });

      out(`Created ${role} account for ${parsed.data}.`);
      out();
      out(`  One-time password: ${oneTimePassword}`);
      out();
      out('Shown once. It is not stored in plaintext and not logged.');
      out('The account must change it at first sign-in.');
      return 0;
    }

    case 'admin:reset-password': {
      const user = await findUser(db, requireFlag(args, 'email'));
      describe(user);
      requireConfirm(args, 'reset this password');

      const oneTimePassword = generateOneTimePassword();
      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(oneTimePassword),
          mustChangePassword: true,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          revision: sql`${users.revision} + 1`,
        })
        .where(eq(users.id, user.id));

      await revokeAllForUser(db, user.id);

      await recordAudit(db, {
        action: 'user.password_reset',
        actor: cliActor(),
        entityType: 'user',
        entityId: user.id,
        metadata: cliMetadata(args.command, { target: user.email }),
      });

      out();
      out(`  One-time password: ${oneTimePassword}`);
      out();
      out('Shown once. Existing sessions have been revoked.');
      return 0;
    }

    case 'admin:disable-totp': {
      const user = await findUser(db, requireFlag(args, 'email'));
      describe(user);
      requireConfirm(args, 'clear two-factor for this account');

      await db
        .update(users)
        .set({
          totpSecretEnc: null,
          totpEnabledAt: null,
          updatedAt: new Date(),
          revision: sql`${users.revision} + 1`,
        })
        .where(eq(users.id, user.id));

      await recordAudit(db, {
        action: 'user.totp_reset',
        actor: cliActor(),
        entityType: 'user',
        entityId: user.id,
        metadata: cliMetadata(args.command, { target: user.email }),
      });

      out();
      out('Two-factor cleared. The account will be asked to enrol again at next sign-in.');
      return 0;
    }

    case 'admin:unlock': {
      const user = await findUser(db, requireFlag(args, 'email'));

      await db
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      await recordAudit(db, {
        action: 'user.unlock',
        actor: cliActor(),
        entityType: 'user',
        entityId: user.id,
        metadata: cliMetadata(args.command, { target: user.email }),
      });

      out(`Unlocked ${user.email}.`);
      return 0;
    }

    case 'admin:list': {
      const rows = await db
        .select({
          email: users.email,
          displayName: users.displayName,
          status: users.status,
          totpEnabledAt: users.totpEnabledAt,
          lockedUntil: users.lockedUntil,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.role, 'admin'));

      await recordAudit(db, {
        action: 'user.list',
        actor: cliActor(),
        entityType: 'user',
        metadata: cliMetadata(args.command, { count: rows.length }),
      });

      if (rows.length === 0) {
        out('No admin accounts exist. Create one with admin:create.');
        return 0;
      }

      out(`${rows.length} admin account${rows.length === 1 ? '' : 's'}:`);
      out();
      for (const row of rows) {
        const locked = row.lockedUntil && row.lockedUntil > new Date() ? ' LOCKED' : '';
        const totp = row.totpEnabledAt ? 'totp' : 'no totp';
        const seen = row.lastLoginAt ? row.lastLoginAt.toISOString() : 'never signed in';
        out(`  ${row.email}  (${row.status}, ${totp})${locked}`);
        out(`      ${row.displayName}, last sign-in ${seen}`);
      }

      const active = await countActiveAdmins(db);
      out();
      out(
        active > 1
          ? `${active} active admins, so a lockout is recoverable in the app.`
          : 'Only one active admin. Keep a second one, and store recovery codes physically.',
      );
      return 0;
    }

    case 'admin:revoke-sessions': {
      const user = await findUser(db, requireFlag(args, 'email'));
      describe(user);
      requireConfirm(args, 'revoke every session for this account');

      await revokeAllForUser(db, user.id);
      await requestDeviceWipe(db, user.id);

      await recordAudit(db, {
        action: 'user.sessions_revoked',
        actor: cliActor(),
        entityType: 'user',
        entityId: user.id,
        metadata: cliMetadata(args.command, { target: user.email }),
      });

      out();
      out('All sessions and refresh tokens revoked. Devices flagged for local wipe.');
      return 0;
    }

    case 'audit:verify': {
      const result = await verifyAuditChain(db);

      await recordAudit(db, {
        action: 'audit.verify',
        actor: cliActor(),
        metadata: cliMetadata(args.command, {
          ok: result.ok,
          rowsChecked: result.rowsChecked,
        }),
      });

      if (result.ok) {
        out(`Audit chain intact across ${result.rowsChecked} rows.`);
        return 0;
      }

      out(`AUDIT CHAIN BROKEN after ${result.rowsChecked} rows.`);
      out(`  First bad row: ${result.brokenAtId}`);
      out(`  Reason:        ${result.reason}`);
      out();
      out('Treat this as a possible tampering incident. Do not clear it.');
      return 2;
    }

    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;

    default:
      throw new CliError(`Unknown command: ${args.command}\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    out(USAGE);
    process.exit(1);
  }

  const config = loadConfig();

  // Fail early if the master key is wrong, so a recovery attempt does not get
  // half way and leave a partly-updated account.
  KeyRing.fromEnv(config.MASTER_KEY);

  const { db, sql: client } = createDatabase(config.migrateDatabaseUrl);

  try {
    if (await migrationsPending(db)) {
      throw new CliError(
        'The database has pending migrations. Start the API to apply them, then run this again.',
      );
    }

    const code = await run(db, parseArgs(argv));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
