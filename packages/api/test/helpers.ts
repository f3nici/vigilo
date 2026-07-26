import { randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { provisionAppRole, runMigrations } from '../src/db/migrate.js';
import { KeyRing } from '../src/crypto/keys.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { encryptField } from '../src/crypto/fields.js';
import { generateTotpSecret } from '../src/services/totp.js';
import { TOTP_SECRET_COLUMN } from '../src/services/auth.js';
import { participantAssignments, participants, teamScopes, users } from '../src/db/schema.js';
import { totpRequired, type Role } from '@vigilo/shared';

/**
 * Integration harness.
 *
 * The API is deliberately given the restricted `vigilo_app` role rather than
 * the owner, so the audit-log grants under test are the ones actually in
 * force. `ownerDb` is only used for setup and for assertions that need to see
 * past those restrictions.
 */

export const OWNER_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://vigilo:vigilo@localhost:5432/vigilo_test';

const APP_PASSWORD = 'test-app-role-password';

function appUrl(): string {
  const url = new URL(OWNER_URL);
  url.username = 'vigilo_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

export const MASTER_KEY = randomBytes(32).toString('base64');

export type Harness = {
  app: Express;
  /** The connection the API serves with: restricted app role. */
  db: Database;
  /** Owner connection, for setup and for reading past the restrictions. */
  ownerDb: Database;
  config: Config;
  keyRing: KeyRing;
  close: () => Promise<void>;
};

export async function createHarness(): Promise<Harness> {
  const owner = createDatabase(OWNER_URL);
  await runMigrations(owner.db);
  await provisionAppRole(owner.db, 'vigilo_app', APP_PASSWORD);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl(),
    MIGRATE_DATABASE_URL: OWNER_URL,
    MASTER_KEY,
    LOG_LEVEL: 'silent',
    BUILD_HASH: 'test-build',
    MIGRATE_ON_START: 'false',
    SESSION_COOKIE_SECURE: 'false',
    MAX_FAILED_ATTEMPTS: '10',
  } as NodeJS.ProcessEnv);

  const appConn = createDatabase(config.DATABASE_URL);
  const keyRing = KeyRing.fromEnv(MASTER_KEY);
  const app = createApp(config, createLogger('silent'), appConn.db, keyRing);

  return {
    app,
    db: appConn.db,
    ownerDb: owner.db,
    config,
    keyRing,
    close: async () => {
      await appConn.sql.end();
      await owner.sql.end();
    },
  };
}

/**
 * Wipes everything the identity tests touch. The audit log has no DELETE grant
 * for the app role, so this runs as the owner.
 */
export async function resetData(ownerDb: Database): Promise<void> {
  await ownerDb.execute(sql`
    truncate table
      audit_log,
      audit_view_batches,
      auth_challenges,
      refresh_tokens,
      sessions,
      recovery_codes,
      devices,
      participant_assignments,
      team_scopes,
      users,
      participants
    restart identity cascade
  `);
}

export const TEST_PASSWORD = 'a-long-enough-test-passphrase';

export type SeededUser = {
  id: string;
  email: string;
  role: Role;
  password: string;
  /** Set when the account is enrolled, so tests can answer the challenge. */
  totpSecret: string | null;
};

export async function seedUser(
  ownerDb: Database,
  keyRing: KeyRing,
  options: {
    role: Role;
    email?: string;
    password?: string;
    mustChangePassword?: boolean;
    participantId?: string | null;
    status?: 'active' | 'suspended' | 'archived';
    /**
     * Defaults to enrolled for the roles that require it, with a real working
     * secret, so `signIn` walks the same second-factor flow the product does.
     */
    totpEnabled?: boolean;
  },
): Promise<SeededUser> {
  const password = options.password ?? TEST_PASSWORD;
  const email = options.email ?? `${options.role}-${randomUUID().slice(0, 8)}@example.org`;
  const enrolled = options.totpEnabled ?? totpRequired(options.role);
  const secret = enrolled ? generateTotpSecret() : null;

  const [row] = await ownerDb
    .insert(users)
    .values({
      email,
      displayName: `Test ${options.role}`,
      role: options.role,
      participantId: options.participantId ?? null,
      passwordHash: await hashPassword(password),
      // Seeded accounts are already set up unless a test says otherwise, so
      // tests are not all forced through the change-password flow.
      mustChangePassword: options.mustChangePassword ?? false,
      status: options.status ?? 'active',
      totpSecretEnc: secret ? encryptField(keyRing, TOTP_SECRET_COLUMN, secret) : null,
      totpEnabledAt: enrolled ? new Date() : null,
    })
    .returning();

  return { id: row!.id, email, role: options.role, password, totpSecret: secret };
}

export type SignedIn = {
  cookies: string[];
  csrfToken: string;
};

/**
 * Signs in through the real routes, completing the TOTP challenge when the
 * account is enrolled. Returns what a browser would hold afterwards.
 */
export async function signIn(h: Harness, user: SeededUser): Promise<SignedIn> {
  const login = await request(h.app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password });

  if (login.status !== 200) {
    throw new Error(
      `Sign-in failed for ${user.email}: ${login.status} ${JSON.stringify(login.body)}`,
    );
  }

  let response = login;

  if (login.body.result === 'totp_required') {
    if (!user.totpSecret) throw new Error('A challenge was issued but the test has no secret');

    response = await request(h.app)
      .post('/api/v1/auth/totp')
      .send({
        challengeId: login.body.challengeId,
        code: currentTotpCode(user.totpSecret),
      });

    if (response.status !== 200) {
      throw new Error(`TOTP step failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
  }

  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
  const csrfToken = /vigilo_csrf=([^;]+)/.exec(cookies.join(';'))?.[1] ?? '';

  return { cookies, csrfToken };
}

/** The code an authenticator app would be showing right now. */
export function currentTotpCode(secret: string): string {
  return new TOTP({
    issuer: 'Vigilo',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

export async function seedParticipant(ownerDb: Database): Promise<string> {
  const [row] = await ownerDb.insert(participants).values({}).returning();
  return row!.id;
}

export async function assign(
  ownerDb: Database,
  userId: string,
  participantId: string,
  options: { kind?: 'standing' | 'temporary'; expiresAt?: Date; reason?: string } = {},
): Promise<void> {
  const kind = options.kind ?? 'standing';
  await ownerDb.insert(participantAssignments).values({
    userId,
    participantId,
    kind,
    expiresAt:
      kind === 'temporary' ? (options.expiresAt ?? new Date(Date.now() + 3_600_000)) : null,
    reason: kind === 'temporary' ? (options.reason ?? 'covering a shift') : null,
  });
}

export async function addTeamScope(
  ownerDb: Database,
  userId: string,
  participantId: string,
): Promise<void> {
  await ownerDb.insert(teamScopes).values({ userId, participantId });
}

/** Two-factor is mandatory for these roles, so most tests enrol nobody. */
export async function auditActions(ownerDb: Database): Promise<string[]> {
  const rows = await ownerDb.execute<{ action: string }>(
    sql`select action from audit_log order by id`,
  );
  return rows.map((row) => row.action);
}
