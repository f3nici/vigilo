import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema through Phase 1 (doc 03).
 *
 * Participants exist here as a skeleton only: users.participant_id and
 * participant_assignments both reference it, and the scope resolver cannot be
 * tested without it. Phase 2 adds the encrypted detail columns, alerts,
 * contacts, emergency plans and the CRUD around them.
 */

/** citext, so email uniqueness is case-insensitive without a functional index. */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** bytea for envelope-encrypted values. */
const encrypted = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const roleEnum = pgEnum('user_role', [
  'admin',
  'team_leader',
  'nurse',
  'worker',
  'participant',
]);
export const userStatusEnum = pgEnum('user_status', ['active', 'suspended', 'archived']);
export const participantStatusEnum = pgEnum('participant_status', ['active', 'archived']);
export const platformEnum = pgEnum('device_platform', ['android', 'ios', 'web']);
export const assignmentKindEnum = pgEnum('assignment_kind', ['standing', 'temporary']);

/** Single row, id always 1. Drives every window and "daily" calculation. */
export const orgSettings = pgTable(
  'org_settings',
  {
    id: smallint('id').primaryKey(),
    orgName: text('org_name').notNull(),
    timezone: text('timezone').notNull().default('Australia/Melbourne'),
    retentionYears: smallint('retention_years').notNull().default(7),
    lateEntryCutoffMinutes: integer('late_entry_cutoff_minutes').notNull().default(1440),
    windowWarningMinutes: integer('window_warning_minutes').notNull().default(20),
    escalationDelayMinutes: integer('escalation_delay_minutes').notNull().default(30),
    sessionIdleMinutesWeb: integer('session_idle_minutes_web').notNull().default(60),
    sessionIdleMinutesMobile: integer('session_idle_minutes_mobile').notNull().default(720),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('org_settings_single_row', sql`${table.id} = 1`)],
);

export type OrgSettings = typeof orgSettings.$inferSelect;

/** So a cron that stopped firing is visible (doc 02 §6). */
export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobName: text('job_name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
});

export type JobRun = typeof jobRuns.$inferSelect;

/**
 * Phase 2 fills this out. Phase 1 needs the table to exist because identity
 * and access both point at it.
 */
export const participants = pgTable('participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  firstNameEnc: encrypted('first_name_enc'),
  lastNameEnc: encrypted('last_name_enc'),
  nameSearchBidx: encrypted('name_search_bidx'),
  status: participantStatusEnum('status').notNull().default('active'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
});

export type Participant = typeof participants.$inferSelect;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Login identifier. Nothing is ever sent to it. */
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    displayName: text('display_name').notNull(),
    role: roleEnum('role').notNull(),
    participantId: uuid('participant_id').references(() => participants.id),
    status: userStatusEnum('status').notNull().default('active'),
    totpSecretEnc: encrypted('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    failedAttempts: smallint('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // A participant account is tied to a participant, and no other role may be.
    check(
      'users_participant_id_matches_role',
      sql`(${table.role} = 'participant') = (${table.participantId} IS NOT NULL)`,
    ),
    index('users_role_idx').on(table.role),
    index('users_status_idx').on(table.status),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Single use, hashed at rest, shown once at enrolment. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

/** Web sessions, for the office experience in a plain browser tab. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Double-submit CSRF token, checked on every mutation. */
    csrfTokenHash: text('csrf_token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const devices = pgTable(
  'devices',
  {
    /** Device-generated, stable across app restarts. */
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    model: text('model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    pushToken: text('push_token'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncRevision: bigint('last_sync_revision', { mode: 'number' }),
    /** Set when the account is suspended, honoured at next contact. */
    wipeRequestedAt: timestamp('wipe_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('devices_user_idx').on(table.userId)],
);

/** Rotating. Reuse of a used token revokes the whole family. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

/** Which participants a team leader or nurse oversees. */
export const teamScopes = pgTable(
  'team_scopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('team_scopes_user_idx').on(table.userId),
    index('team_scopes_participant_idx').on(table.participantId),
  ],
);

export const participantAssignments = pgTable(
  'participant_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: assignmentKindEnum('kind').notNull(),
    reason: text('reason'),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // A temporary grant needs both an expiry and a reason; a standing one has
    // neither. Enforced here so no route can write a grant that never expires.
    check(
      'assignments_temporary_needs_expiry_and_reason',
      sql`(${table.kind} = 'temporary') = (${table.expiresAt} IS NOT NULL AND ${table.reason} IS NOT NULL)`,
    ),
    index('assignments_user_idx').on(table.userId),
    index('assignments_participant_idx').on(table.participantId),
  ],
);

/**
 * Append-only and hash-chained (doc 03 §10, doc 07 §4).
 *
 * The application database role has INSERT and SELECT only: no UPDATE, no
 * DELETE, enforced by grants in the migration and by a trigger as defence in
 * depth. Views are logged as well as writes.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** Null for system actions, including the break-glass CLI. */
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorIp: text('actor_ip'),
    actorDeviceId: uuid('actor_device_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    participantId: uuid('participant_id'),
    /** Redacted. Never holds clinical values or names. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (table) => [
    index('audit_log_actor_idx').on(table.actorUserId),
    index('audit_log_participant_idx').on(table.participantId, table.at),
    index('audit_log_action_idx').on(table.action, table.at),
  ],
);

export type AuditRow = typeof auditLog.$inferSelect;

/**
 * Batches participant view events to one row per user per participant per 15
 * minutes, so an access audit stays answerable without drowning in rows
 * (doc 07 §4).
 */
export const auditViewBatches = pgTable(
  'audit_view_batches',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('audit_view_batches_key').on(table.userId, table.participantId, table.windowStart),
  ],
);

/** Short-lived login challenges, issued when a second factor is required. */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    deviceId: uuid('device_id'),
    platform: platformEnum('platform'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('auth_challenges_token_idx').on(table.tokenHash)],
);
