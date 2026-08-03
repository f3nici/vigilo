import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { provisionAppRole, runMigrations } from '../src/db/migrate.js';
import { invalidateOrgSettings } from '../src/services/org.js';
import { blindIndex, KeyRing } from '../src/crypto/keys.js';
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
  /** Throwaway attachment volume for this run. */
  attachmentDir: string;
  close: () => Promise<void>;
};

export async function createHarness(): Promise<Harness> {
  const owner = createDatabase(OWNER_URL);
  await runMigrations(owner.db);
  await provisionAppRole(owner.db, 'vigilo_app', APP_PASSWORD);

  // Attachments land in a throwaway directory per run, so a suite never reads
  // a file another suite wrote and the real volume is never touched.
  const attachmentDir = await mkdtemp(path.join(tmpdir(), 'vigilo-attachments-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl(),
    MIGRATE_DATABASE_URL: OWNER_URL,
    MASTER_KEY,
    ATTACHMENT_DIR: attachmentDir,
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
    attachmentDir,
    close: async () => {
      await appConn.sql.end();
      await owner.sql.end();
      await rm(attachmentDir, { recursive: true, force: true });
    },
  };
}

/**
 * Wipes everything the identity tests touch. The audit log has no DELETE grant
 * for the app role, so this runs as the owner.
 */
/**
 * The timezone every test in this repository is written against. Melbourne
 * because it has daylight saving, which is where window arithmetic breaks.
 */
export const TEST_TIME_ZONE = 'Australia/Melbourne';

export async function resetData(ownerDb: Database): Promise<void> {
  await ownerDb.execute(sql`
    truncate table
      audit_log,
      audit_view_batches,
      auth_challenges,
      refresh_tokens,
      sessions,
      recovery_codes,
      export_jobs,
      notifications_sent,
      notification_preferences,
      push_subscriptions,
      sync_applied_ops,
      sync_deletions,
      devices,
      sync_scope_changes,
      participant_assignments,
      team_scopes,
      participant_alerts,
      emergency_contacts,
      emergency_plans,
      check_entry_notes,
      check_entry_revisions,
      check_entry_values,
      check_entries,
      window_miss_reasons,
      check_windows,
      check_schedule_segments,
      check_schedules,
      check_template_versions,
      check_templates,
      coverage_patterns,
      coverage_exceptions,
      incident_actions,
      incidents,
      care_plan_reads,
      care_plan_versions,
      care_plans,
      medication_administrations,
      medication_doses,
      medication_schedules,
      medications,
      diary_entry_revisions,
      diary_entries,
      diary_categories,
      attachments,
      users,
      participants
    restart identity cascade
  `);

  // The seeded reason codes come from migration 0008 and are configuration
  // rather than test data, so they are put back rather than left truncated.
  await ownerDb.execute(sql`
    insert into missed_reason_codes (code, label, requires_note, sort_order)
    values
      ('asleep', 'Participant was asleep', false, 10),
      ('refused', 'Participant refused', false, 20),
      ('not_home', 'Participant was not home', false, 30),
      ('staff_emergency', 'Staff attending an emergency', false, 40),
      ('equipment_unavailable', 'Equipment unavailable', false, 50),
      ('family_supporting', 'Family was supporting', false, 60),
      ('forgot', 'Forgot to record it', false, 70),
      ('other', 'Something else', true, 80)
    on conflict (code) do update set active = true, requires_note = excluded.requires_note
  `);

  // Same for the diary categories seeded by migration 0010. They are
  // configuration, not test data, so an entry always has something to be
  // filed under. Truncated first rather than upserted, so a category a test
  // creates does not survive into the next run and collide with itself.
  await ownerDb.execute(sql`
    insert into diary_categories (slug, label, colour, sort_order)
    values
      ('personal_care', 'Personal care', 'sky', 10),
      ('behaviour', 'Behaviour', 'peach', 20),
      ('activity', 'Activity', 'sage', 30),
      ('medical', 'Medical', 'rose', 40),
      ('communication', 'Communication', 'lavender', 50),
      ('family_contact', 'Family contact', 'teal', 60),
      ('equipment', 'Equipment', 'sand', 70),
      ('other', 'Other', 'slate', 80)
    on conflict (slug) do update set active = true
  `);

  /*
   * The org timezone, set explicitly rather than left to the column default.
   *
   * Every window time, every "daily" boundary and every assertion about clock
   * hours in this suite is decided by it. Leaving it to the default meant the
   * whole suite quietly changed meaning the day the default moved from
   * Melbourne to Perth (D84), which is exactly what happened. `TEST_TIME_ZONE`
   * is what the tests mean; the product's default is a separate question and
   * has its own test.
   */
  await ownerDb.execute(sql`
    update org_settings set timezone = ${TEST_TIME_ZONE} where id = 1
  `);
  invalidateOrgSettings();
}

/** The vent observation form the documents use, ready to publish. */
export const VENT_SCHEMA = {
  fields: [
    {
      key: 'urine_output',
      label: 'Urine output',
      type: 'number',
      unit: 'ml',
      decimals: 0,
      min: 0,
      max: 5000,
      required: true,
      help: 'Since the last check',
      sort: 10,
    },
    {
      key: 'vent_mode',
      label: 'Ventilator mode',
      type: 'single_choice',
      options: [
        { value: 'cpap', label: 'CPAP' },
        { value: 'bipap', label: 'BiPAP' },
      ],
      required: true,
      sort: 20,
    },
    {
      key: 'cares',
      label: 'Cares completed',
      type: 'checklist',
      items: [
        { value: 'repositioned', label: 'Repositioned' },
        { value: 'mouth_care', label: 'Mouth care' },
      ],
      required: false,
      sort: 30,
    },
    {
      key: 'comment',
      label: 'Comment',
      type: 'text',
      multiline: true,
      maxLength: 2000,
      required: false,
      sort: 40,
    },
  ],
};

export const TEST_PASSWORD = 'a-long-enough-test-passphrase';

export type SeededUser = {
  id: string;
  email: string;
  role: Role;
  displayName: string;
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
    /**
     * Defaults to `Test <role>`, which most tests assert against. Set it when a
     * test seeds two of the same role and has to tell them apart.
     */
    displayName?: string;
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
  const displayName = options.displayName ?? `Test ${options.role}`;
  const enrolled = options.totpEnabled ?? totpRequired(options.role);
  const secret = enrolled ? generateTotpSecret() : null;

  const [row] = await ownerDb
    .insert(users)
    .values({
      email,
      displayName,
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

  return { id: row!.id, email, role: options.role, displayName, password, totpSecret: secret };
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

let ndisCounter = 100000000;

/**
 * A participant record straight into the database, encrypted the same way the
 * service would. Tests that are about scope should not have to walk the whole
 * create flow to get someone to be out of scope of.
 */
export async function seedParticipant(
  ownerDb: Database,
  keyRing: KeyRing,
  options: { firstName?: string; lastName?: string; ndisNumber?: string } = {},
): Promise<string> {
  const firstName = options.firstName ?? 'Test';
  const lastName = options.lastName ?? 'Participant';
  const ndisNumber = options.ndisNumber ?? String(++ndisCounter);

  const [row] = await ownerDb
    .insert(participants)
    .values({
      firstNameEnc: encryptField(keyRing, 'participants.first_name_enc', firstName),
      lastNameEnc: encryptField(keyRing, 'participants.last_name_enc', lastName),
      nameSearchBidx: blindIndex(keyRing, 'participants.name_search_bidx', lastName),
      dobEnc: encryptField(keyRing, 'participants.dob_enc', '1990-01-01'),
      ndisNumberEnc: encryptField(keyRing, 'participants.ndis_number_enc', ndisNumber),
      ndisNumberBidx: blindIndex(keyRing, 'participants.ndis_number_bidx', ndisNumber),
    })
    .returning();

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
