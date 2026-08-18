import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema through Phase 4 (doc 03).
 *
 * `revision` on a syncable table is fed by one global sequence through a
 * trigger, not by the column default and not by the application. It is what
 * sync cursors walk in Phase 5, so it has to be monotonic across every table
 * at once (doc 03 conventions). The `.default(0)` below only keeps the insert
 * types convenient; the trigger overwrites it on every insert and update.
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
export const alertKindEnum = pgEnum('alert_kind', [
  'allergy',
  'medical',
  'behavioural',
  'communication',
  'other',
]);
export const alertSeverityEnum = pgEnum('alert_severity', ['info', 'warning', 'critical']);
export const scopeChangeEffectEnum = pgEnum('scope_change_effect', ['granted', 'revoked']);
export const templateStatusEnum = pgEnum('check_template_status', ['active', 'retired']);
export const versionStatusEnum = pgEnum('check_version_status', [
  'draft',
  'published',
  'superseded',
]);
export const scheduleStatusEnum = pgEnum('check_schedule_status', ['active', 'paused', 'ended']);
export const coverageEffectEnum = pgEnum('coverage_effect', ['covered', 'not_covered']);
export const windowStatusEnum = pgEnum('check_window_status', [
  'pending',
  'partial',
  'complete',
  'missed',
  'not_expected',
]);
export const entryStatusEnum = pgEnum('check_entry_status', ['partial', 'complete']);
export const diaryCategoryColourEnum = pgEnum('diary_category_colour', [
  'lavender',
  'sky',
  'teal',
  'sage',
  'sand',
  'peach',
  'rose',
  'slate',
]);
export const diaryRevisionFieldEnum = pgEnum('diary_revision_field', [
  'body',
  'category',
  'occurred_at',
  'visibility',
]);
export const attachmentOwnerTypeEnum = pgEnum('attachment_owner_type', [
  'diary_entry',
  'incident',
  'participant_photo',
]);
export const attachmentUploadStateEnum = pgEnum('attachment_upload_state', [
  'pending',
  'complete',
  'failed',
]);
export const carePlanStatusEnum = pgEnum('care_plan_status', ['draft', 'published', 'archived']);
export const carePlanVersionStatusEnum = pgEnum('care_plan_version_status', [
  'draft',
  'published',
  'superseded',
]);
export const incidentSeverityEnum = pgEnum('incident_severity', ['low', 'moderate', 'high']);
export const incidentStatusEnum = pgEnum('incident_status', ['open', 'under_review', 'closed']);
export const administrationStatusEnum = pgEnum('medication_administration_status', [
  'given',
  'refused',
  'withheld',
  'not_required',
  'self_administered',
]);
export const doseStatusEnum = pgEnum('medication_dose_status', [
  'pending',
  'given',
  'refused',
  'withheld',
  'not_required',
  'self_administered',
  'missed',
]);

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
    /**
     * How long after a due time a dose is still simply due. A check has a
     * window with two ends; a dose has one instant, so without this every dose
     * would be missed the moment it came due.
     */
    medicationGraceMinutes: integer('medication_grace_minutes').notNull().default(60),
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
 * The participant record (doc 03 §3).
 *
 * Every identifying field is ciphertext. Listing means decrypting names row by
 * row, which is fine at 200 participants and is the reason there is no
 * server-side free-text name search: the blind indexes allow exact match only.
 */
export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstNameEnc: encrypted('first_name_enc').notNull(),
    lastNameEnc: encrypted('last_name_enc').notNull(),
    preferredNameEnc: encrypted('preferred_name_enc'),
    /** HMAC of the lowercased surname. Exact match only, never a prefix. */
    nameSearchBidx: encrypted('name_search_bidx').notNull(),
    dobEnc: encrypted('dob_enc').notNull(),
    ndisNumberEnc: encrypted('ndis_number_enc').notNull(),
    /** Unique, which is what stops the same person being added twice. */
    ndisNumberBidx: encrypted('ndis_number_bidx').notNull(),
    addressEnc: encrypted('address_enc'),
    phoneEnc: encrypted('phone_enc'),
    emailEnc: encrypted('email_enc'),
    /** General admin notes. Clinical detail belongs in the diary. */
    notesEnc: encrypted('notes_enc'),
    status: participantStatusEnum('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    uniqueIndex('participants_ndis_bidx_key').on(table.ndisNumberBidx),
    index('participants_name_bidx_idx').on(table.nameSearchBidx),
    index('participants_status_idx').on(table.status),
    index('participants_revision_idx').on(table.revision),
  ],
);

export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;

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
 * High-visibility flags pinned above every screen for that participant
 * (doc 03 §3). Severity drives colour and nothing else: it says how urgently a
 * human should read this, never whether a recorded value is good or bad.
 */
export const participantAlerts = pgTable(
  'participant_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    kind: alertKindEnum('kind').notNull(),
    severity: alertSeverityEnum('severity').notNull(),
    textEnc: encrypted('text_enc').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('participant_alerts_participant_idx').on(table.participantId),
    index('participant_alerts_revision_idx').on(table.revision),
  ],
);

export type ParticipantAlertRow = typeof participantAlerts.$inferSelect;

export const emergencyContacts = pgTable(
  'emergency_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    nameEnc: encrypted('name_enc').notNull(),
    relationshipEnc: encrypted('relationship_enc').notNull(),
    phonePrimaryEnc: encrypted('phone_primary_enc').notNull(),
    phoneSecondaryEnc: encrypted('phone_secondary_enc'),
    emailEnc: encrypted('email_enc'),
    isPrimary: boolean('is_primary').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    notesEnc: encrypted('notes_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('emergency_contacts_participant_idx').on(table.participantId),
    index('emergency_contacts_revision_idx').on(table.revision),
  ],
);

export type EmergencyContactRow = typeof emergencyContacts.$inferSelect;

/** One per participant, and it must be readable offline at all times. */
export const emergencyPlans = pgTable(
  'emergency_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    bodyEnc: encrypted('body_enc').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('emergency_plans_participant_key').on(table.participantId),
    index('emergency_plans_revision_idx').on(table.revision),
  ],
);

export type EmergencyPlanRow = typeof emergencyPlans.$inferSelect;

/**
 * Check templates (doc 03 §4). The template is the name and the lifecycle; the
 * fields live on its versions, because a form that changed in March must not
 * corrupt February's records.
 */
export const checkTemplates = pgTable(
  'check_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    status: templateStatusEnum('status').notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('check_templates_status_idx').on(table.status),
    index('check_templates_revision_idx').on(table.revision),
  ],
);

export type CheckTemplateRow = typeof checkTemplates.$inferSelect;

/**
 * A frozen field set. Published versions are immutable: entries reference the
 * version rather than the template, so a historical record always renders with
 * the fields it was recorded against (doc 03 §4).
 *
 * There is no database constraint stopping an UPDATE on a published row,
 * because the app role legitimately supersedes them. The immutability is
 * enforced in the service, which refuses any schema edit that is not a draft.
 */
export const checkTemplateVersions = pgTable(
  'check_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => checkTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** The ordered field definition. Shape and rules in @vigilo/shared. */
    schema: jsonb('schema').$type<{ fields: unknown[] }>().notNull(),
    status: versionStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('check_template_versions_number_key').on(table.templateId, table.version),
    index('check_template_versions_template_idx').on(table.templateId),
    index('check_template_versions_revision_idx').on(table.revision),
  ],
);

export type CheckTemplateVersionRow = typeof checkTemplateVersions.$inferSelect;

/**
 * Which forms belong to which participant (D94).
 *
 * A check form is written once and used for whoever it suits: a bowel chart, a
 * seizure record, a blood pressure. Offering every one of them to a worker
 * recording a check for somebody they none of them apply to is how the wrong
 * form gets filled in, and it gets worse with every form the org adds.
 *
 * An admin ticks the ones that apply. This is about what a worker is offered
 * when they record on demand; it is not a permission, and it is not a
 * schedule. A form scheduled for a participant is theirs whether or not it is
 * ticked here, because the schedule already said so.
 */
export const participantCheckForms = pgTable(
  'participant_check_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => checkTemplates.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('participant_check_forms_key').on(table.participantId, table.templateId),
    index('participant_check_forms_participant_idx').on(table.participantId),
    index('participant_check_forms_revision_idx').on(table.revision),
  ],
);

export type ParticipantCheckFormRow = typeof participantCheckForms.$inferSelect;

/** One participant, one template, and the grid rules underneath (doc 03 §5). */
export const checkSchedules = pgTable(
  'check_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => checkTemplates.id),
    name: text('name').notNull(),
    activeFrom: date('active_from').notNull(),
    activeTo: date('active_to'),
    status: scheduleStatusEnum('status').notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('check_schedules_participant_idx').on(table.participantId),
    index('check_schedules_status_idx').on(table.status),
    index('check_schedules_revision_idx').on(table.revision),
  ],
);

export type CheckScheduleRow = typeof checkSchedules.$inferSelect;

/**
 * The grid itself, and the thing an admin actually sets up. `applies_to_time`
 * at or before `applies_from_time` means the segment crosses midnight.
 * Overlap between segments is refused in the service, where the whole set is
 * visible at once; a per-row constraint cannot see the set.
 */
export const checkScheduleSegments = pgTable(
  'check_schedule_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => checkSchedules.id, { onDelete: 'cascade' }),
    label: text('label'),
    windowMinutes: integer('window_minutes').notNull().default(120),
    anchorTime: time('anchor_time').notNull(),
    appliesFromTime: time('applies_from_time').notNull(),
    appliesToTime: time('applies_to_time').notNull(),
    /** Null means every day. 0 is Sunday. */
    weekdays: smallint('weekdays').array(),
    sortOrder: smallint('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    check('segments_window_minutes_sane', sql`${table.windowMinutes} between 5 and 1440`),
    index('check_schedule_segments_schedule_idx').on(table.scheduleId),
    index('check_schedule_segments_revision_idx').on(table.revision),
  ],
);

export type CheckScheduleSegmentRow = typeof checkScheduleSegments.$inferSelect;

/**
 * Baseline supported hours (doc 03 §5). Superseded rows keep their dates rather
 * than being deleted, so recalculating a past week uses the pattern that
 * actually applied then instead of today's.
 */
export const coveragePatterns = pgTable(
  'coverage_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    weekday: smallint('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    activeFrom: date('active_from').notNull(),
    activeTo: date('active_to'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    check('coverage_patterns_weekday_range', sql`${table.weekday} between 0 and 6`),
    index('coverage_patterns_participant_idx').on(table.participantId),
    index('coverage_patterns_revision_idx').on(table.revision),
  ],
);

export type CoveragePatternRow = typeof coveragePatterns.$inferSelect;

/** Dated overrides for reality. Exceptions win over the pattern. */
export const coverageExceptions = pgTable(
  'coverage_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    effect: coverageEffectEnum('effect').notNull(),
    /** Plain operational text ("family holiday"), never clinical detail. */
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    check('coverage_exceptions_ends_after_start', sql`${table.endsAt} > ${table.startsAt}`),
    index('coverage_exceptions_participant_idx').on(table.participantId, table.startsAt),
    index('coverage_exceptions_revision_idx').on(table.revision),
  ],
);

export type CoverageExceptionRow = typeof coverageExceptions.$inferSelect;

/**
 * The materialised grid, and the busiest table in the schema (doc 03 §5).
 *
 * Materialised rather than computed on the fly for two reasons: windows carry
 * state, and a device with no signal needs a concrete list to work from.
 *
 * `segment_id` is kept but not cascaded, so history survives a schedule change:
 * a window recorded against last month's grid keeps pointing at the rule that
 * produced it even after the admin replaces that rule.
 */
export const checkWindows = pgTable(
  'check_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => checkSchedules.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id').references(() => checkScheduleSegments.id, {
      onDelete: 'set null',
    }),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => checkTemplateVersions.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    expected: boolean('expected').notNull().default(true),
    /** Why not, in the words the greyed-out row shows (doc 06 §3). */
    coverageReason: text('coverage_reason'),
    status: windowStatusEnum('status').notNull().default('pending'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    isLate: boolean('is_late').notNull().default(false),
    lateByMinutes: integer('late_by_minutes'),
    recalculatedAt: timestamp('recalculated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // The grid is deterministic, so re-running the materialiser must find the
    // window it already made rather than laying a second one on top of it.
    unique('check_windows_grid_key').on(table.scheduleId, table.startsAt, table.segmentId),
    index('check_windows_participant_idx').on(table.participantId, table.startsAt),
    index('check_windows_closer_idx').on(table.status, table.endsAt),
    index('check_windows_revision_idx').on(table.revision),
  ],
);

export type CheckWindowRow = typeof checkWindows.$inferSelect;

/**
 * One entry per window. Partial entry updates this row as more fields are
 * filled, it never writes a second one (doc 03 §6).
 *
 * The id is a UUID v7 generated on the device, so an entry has stable identity
 * before it reaches the server and a replayed request updates rather than
 * duplicates.
 *
 * `window_id` is nullable, for a check somebody recorded on demand rather than
 * because a schedule asked for one (D89). The same shape PRN medication uses.
 * An unscheduled entry has no window, no lateness and no place in the
 * compliance percentage: nothing asked for it, so nothing can say it was late
 * or missed.
 */
export const checkEntries = pgTable(
  'check_entries',
  {
    id: uuid('id').primaryKey(),
    windowId: uuid('window_id').references(() => checkWindows.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => checkTemplateVersions.id),
    recordedBy: uuid('recorded_by').references(() => users.id),
    /** Device time when the worker recorded it. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Server time. Authoritative for lateness, because device clocks drift. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    status: entryStatusEnum('status').notNull().default('partial'),
    isLate: boolean('is_late').notNull().default(false),
    deviceId: uuid('device_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editCount: integer('edit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // Partial, so an unscheduled entry does not collide with every other one.
    // Declared in migration 0019 because Drizzle cannot express the predicate.
    index('check_entries_participant_idx').on(table.participantId, table.recordedAt),
    index('check_entries_revision_idx').on(table.revision),
  ],
);

export type CheckEntryRow = typeof checkEntries.$inferSelect;

/**
 * One row per answered field (doc 03 §6).
 *
 * `value_number` is plaintext and `value_text_enc` is not, which is Option A
 * from doc 03 §6, locked as A8. Trends and compliance stay plain SQL over the
 * numbers, and the free text a worker types about a person is encrypted. The
 * two are not mixed.
 *
 * `unit` is copied from the schema at write time so the record survives a
 * later version changing it.
 */
export const checkEntryValues = pgTable(
  'check_entry_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => checkEntries.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    /** numeric, not float: a clinical value must not be rounded on the way in. */
    valueNumber: numeric('value_number'),
    valueBool: boolean('value_bool'),
    valueTextEnc: encrypted('value_text_enc'),
    valueJson: jsonb('value_json'),
    unit: text('unit'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('check_entry_values_field_key').on(table.entryId, table.fieldKey),
    index('check_entry_values_entry_idx').on(table.entryId),
    index('check_entry_values_revision_idx').on(table.revision),
  ],
);

export type CheckEntryValueRow = typeof checkEntryValues.$inferSelect;

/**
 * Append-only edit history (doc 01 §5.5). Never updated, never deleted: the
 * original value of a clinical record is not something an edit gets to remove.
 *
 * Old and new values are encrypted as a pair, because a revision row holding
 * the plaintext of an encrypted field would be a way around the encryption.
 */
export const checkEntryRevisions = pgTable(
  'check_entry_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => checkEntries.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    valuesEnc: encrypted('values_enc').notNull(),
    changedBy: uuid('changed_by').references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (table) => [index('check_entry_revisions_entry_idx').on(table.entryId, table.changedAt)],
);

export type CheckEntryRevisionRow = typeof checkEntryRevisions.$inferSelect;

/**
 * A note added to a recorded check afterwards (D96).
 *
 * Beside the record, never part of it: the values stay as the worker recorded
 * them and this says what somebody reading them later needs to know. Free text
 * about a person, so encrypted, and append-only, enforced by the grant in
 * migration 0022 rather than by everybody remembering.
 */
export const checkEntryNotes = pgTable(
  'check_entry_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => checkEntries.id, { onDelete: 'cascade' }),
    bodyEnc: encrypted('body_enc').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('check_entry_notes_entry_idx').on(table.entryId, table.createdAt)],
);

export type CheckEntryNoteRow = typeof checkEntryNotes.$inferSelect;

/** Admin-configurable, because this is the organisation's vocabulary. */
export const missedReasonCodes = pgTable(
  'missed_reason_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    label: text('label').notNull(),
    requiresNote: boolean('requires_note').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [index('missed_reason_codes_revision_idx').on(table.revision)],
);

export type MissedReasonCodeRow = typeof missedReasonCodes.$inferSelect;

/** One per window, and the note is free text about a person, so encrypted. */
export const windowMissReasons = pgTable(
  'window_miss_reasons',
  {
    /** Device-generated UUID v7, like an entry. */
    id: uuid('id').primaryKey(),
    windowId: uuid('window_id')
      .notNull()
      .references(() => checkWindows.id, { onDelete: 'cascade' }),
    reasonCodeId: uuid('reason_code_id')
      .notNull()
      .references(() => missedReasonCodes.id),
    noteEnc: encrypted('note_enc'),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    deviceId: uuid('device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('window_miss_reasons_window_key').on(table.windowId),
    index('window_miss_reasons_revision_idx').on(table.revision),
  ],
);

export type WindowMissReasonRow = typeof windowMissReasons.$inferSelect;

/**
 * Diary categories (doc 03 §7). Admin-configurable, seeded with the set from
 * doc 01 §6, and deactivated rather than deleted so past entries keep the
 * category they were filed under.
 */
export const diaryCategories = pgTable(
  'diary_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    colour: diaryCategoryColourEnum('colour').notNull().default('slate'),
    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [index('diary_categories_revision_idx').on(table.revision)],
);

export type DiaryCategoryRow = typeof diaryCategories.$inferSelect;

/**
 * A diary entry (doc 03 §7).
 *
 * `occurred_at` is the time the thing happened and `recorded_at` is the time
 * someone wrote it down. Keeping them apart is what lets a worker catch up at
 * the end of a shift without the record claiming everything happened at once.
 *
 * `body_search_tsv` from doc 03 §7 is deliberately absent. An encrypted body
 * cannot feed a tsvector, and A9 picks option (a): search is per participant
 * over decrypted text, within the caller's scope.
 */
export const diaryEntries = pgTable(
  'diary_entries',
  {
    /** Device-generated UUID v7, so a replayed outbox lands on one row. */
    id: uuid('id').primaryKey(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => diaryCategories.id),
    bodyEnc: encrypted('body_enc').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Staff-controlled, default true (doc 01 §3.7). */
    visibleToParticipant: boolean('visible_to_participant').notNull().default(true),
    deviceId: uuid('device_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editCount: integer('edit_count').notNull().default(0),
    /** Soft delete, admin only, audited. Nothing is removed (doc 04 §8). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('diary_entries_participant_idx').on(table.participantId, table.occurredAt),
    index('diary_entries_revision_idx').on(table.revision),
  ],
);

export type DiaryEntryRow = typeof diaryEntries.$inferSelect;

/**
 * Append-only edit history, the same rule as a check entry (doc 01 §6).
 *
 * Doc 03 §7 sketches this as one row holding an old and a new body plus an old
 * and a new category. That shape has no room for a changed `occurred_at` or a
 * flipped visibility toggle, both of which change what the record means, so
 * this is one row per changed field instead and covers all four.
 *
 * The old and new values are encrypted together, because a history row holding
 * the plaintext of an encrypted body would be a way around the encryption.
 */
export const diaryEntryRevisions = pgTable(
  'diary_entry_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => diaryEntries.id, { onDelete: 'cascade' }),
    field: diaryRevisionFieldEnum('field').notNull(),
    valuesEnc: encrypted('values_enc').notNull(),
    changedBy: uuid('changed_by').references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (table) => [index('diary_entry_revisions_entry_idx').on(table.entryId, table.changedAt)],
);

export type DiaryEntryRevisionRow = typeof diaryEntryRevisions.$inferSelect;

/**
 * Attachments (doc 03 §8, doc 07 §2).
 *
 * The bytes live on the encrypted volume, each file encrypted again under its
 * own data key which is itself wrapped by the master key. `participant_id` is
 * carried on the row so a scope check on a download needs no join, and a
 * download is a per-request scope check, always.
 *
 * `storage_path` is relative, so the volume can move and object storage can
 * replace it later without touching a row.
 */
export const attachments = pgTable(
  'attachments',
  {
    /** Device-generated, so the bytes can follow the metadata later. */
    id: uuid('id').primaryKey(),
    ownerType: attachmentOwnerTypeEnum('owner_type').notNull(),
    /** Null until the entry it belongs to exists, which is the upload order. */
    ownerId: uuid('owner_id'),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /** Of the plaintext, for integrity and later dedupe. */
    sha256: text('sha256'),
    storagePath: text('storage_path'),
    /** Rendered on first request and kept, because re-rendering is not free. */
    thumbnailPath: text('thumbnail_path'),
    encryptionKeyEnc: encrypted('encryption_key_enc'),
    width: integer('width'),
    height: integer('height'),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    uploadState: attachmentUploadStateEnum('upload_state').notNull().default('pending'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('attachments_owner_idx').on(table.ownerType, table.ownerId),
    index('attachments_participant_idx').on(table.participantId),
    index('attachments_revision_idx').on(table.revision),
  ],
);

export type AttachmentRow = typeof attachments.$inferSelect;

/* -------------------------------------------------------------- care plans */

/**
 * Care plans (doc 03 §9, doc 01 §7.1).
 *
 * Versioned the same way check templates are, and for the same reason: a plan
 * that changes in March must not rewrite what the March record said the
 * instructions were. A published version is immutable and a new one supersedes
 * it.
 */
export const carePlans = pgTable(
  'care_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: carePlanStatusEnum('status').notNull().default('draft'),
    /**
     * No foreign key, deliberately. Versions point at the plan and the plan
     * points at its current version, and a circular constraint would make both
     * tables impossible to insert into without a deferred transaction. The
     * service is the only writer and it sets this after the version exists.
     */
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('care_plans_participant_idx').on(table.participantId, table.status),
    index('care_plans_revision_idx').on(table.revision),
  ],
);

export type CarePlanRow = typeof carePlans.$inferSelect;

/**
 * One version. `body_enc` holds the author's source text, not HTML.
 *
 * Doc 07 §7 lists DOMPurify on write and on render as the XSS mitigation. This
 * takes it one step earlier: no HTML is ever stored, so there is no stored HTML
 * for a missed sanitiser call to release. The renderer in
 * `packages/shared/careplans.ts` escapes every character before it emits a tag,
 * and both sides render from that one function (D63).
 */
export const carePlanVersions = pgTable(
  'care_plan_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    carePlanId: uuid('care_plan_id')
      .notNull()
      .references(() => carePlans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    bodyEnc: encrypted('body_enc'),
    status: carePlanVersionStatusEnum('status').notNull().default('draft'),
    changeSummary: text('change_summary'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('care_plan_versions_number_key').on(table.carePlanId, table.version),
    index('care_plan_versions_plan_idx').on(table.carePlanId),
    index('care_plan_versions_revision_idx').on(table.revision),
  ],
);

export type CarePlanVersionRow = typeof carePlanVersions.$inferSelect;

/**
 * Read receipts, which drive the unread marker (doc 01 §7.1).
 *
 * No revision and no sync entity: a device needs to know whether *it* has read
 * the current version, and that travels as a flag on the plan itself. Nobody
 * needs a list of who else has read what on their phone.
 */
export const carePlanReads = pgTable(
  'care_plan_reads',
  {
    id: uuid('id').primaryKey(),
    carePlanVersionId: uuid('care_plan_version_id')
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('care_plan_reads_once').on(table.carePlanVersionId, table.userId),
    index('care_plan_reads_user_idx').on(table.userId),
  ],
);

/* --------------------------------------------------------------- incidents */

/**
 * Incidents (doc 03 §9, doc 01 §7.3).
 *
 * **Never visible to a `participant` role account**, enforced in the scope
 * layer rather than only in the UI. `involved_enc` is not in doc 03's column
 * list; doc 01 §7.3 lists "who was involved" as a field, and it is free text
 * because it includes people with no account (D66).
 *
 * The NDIS Commission reportable-incident workflow is explicitly out of scope.
 */
export const incidents = pgTable(
  'incidents',
  {
    /** Device-generated, so an incident has identity before it is sent. */
    id: uuid('id').primaryKey(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** When somebody found out, which is not when it happened. */
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull(),
    reportedBy: uuid('reported_by').references(() => users.id),
    summaryEnc: encrypted('summary_enc').notNull(),
    detailEnc: encrypted('detail_enc').notNull(),
    immediateActionEnc: encrypted('immediate_action_enc').notNull(),
    injuriesEnc: encrypted('injuries_enc'),
    involvedEnc: encrypted('involved_enc'),
    severity: incidentSeverityEnum('severity').notNull(),
    familyNotifiedAt: timestamp('family_notified_at', { withTimezone: true }),
    status: incidentStatusEnum('status').notNull().default('open'),
    closedBy: uuid('closed_by').references(() => users.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closureNotesEnc: encrypted('closure_notes_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('incidents_participant_idx').on(table.participantId, table.occurredAt),
    index('incidents_status_idx').on(table.status),
    index('incidents_revision_idx').on(table.revision),
  ],
);

export type IncidentRow = typeof incidents.$inferSelect;

/** Follow-up with an assignee and a due date (doc 01 §7.3). */
export const incidentActions = pgTable(
  'incident_actions',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    actionEnc: encrypted('action_enc').notNull(),
    assignedTo: uuid('assigned_to').references(() => users.id),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    noteEnc: encrypted('note_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('incident_actions_incident_idx').on(table.incidentId),
    index('incident_actions_assignee_idx').on(table.assignedTo, table.completedAt),
    index('incident_actions_revision_idx').on(table.revision),
  ],
);

export type IncidentActionRow = typeof incidentActions.$inferSelect;

/* -------------------------------------------------------------- medications */

/**
 * The medication administration record (doc 03 §9, doc 01 §7.2).
 *
 * Deliberately the same four-table shape as checks: a definition, a schedule,
 * a materialised due list and a sign-off. Everything built for the check grid,
 * coverage and the offline outbox included, applies here unchanged, and a
 * second design would only be a second thing that can drift.
 *
 * `dose` is text, not a number and a unit. It is transcribed off a label and
 * has to survive the trip exactly: "half a sachet", "1 to 2 tablets". Splitting
 * it would invite the software to convert or total it, and software that does
 * arithmetic on doses is software that can get a dose wrong.
 */
export const medications = pgTable(
  'medications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    form: text('form'),
    dose: text('dose').notNull(),
    route: text('route'),
    /** Free text about a person's medication, so encrypted (doc 07 §3). */
    instructionsEnc: encrypted('instructions_enc'),
    isPrn: boolean('is_prn').notNull().default(false),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    requiresWitness: boolean('requires_witness').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('medications_participant_idx').on(table.participantId, table.active),
    index('medications_revision_idx').on(table.revision),
  ],
);

export type MedicationRow = typeof medications.$inferSelect;

/** One due time. Null weekdays means every day, as with a check segment. */
export const medicationSchedules = pgTable(
  'medication_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    medicationId: uuid('medication_id')
      .notNull()
      .references(() => medications.id, { onDelete: 'cascade' }),
    timeOfDay: time('time_of_day').notNull(),
    weekdays: smallint('weekdays').array(),
    activeFrom: date('active_from'),
    activeTo: date('active_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('medication_schedules_medication_idx').on(table.medicationId),
    index('medication_schedules_revision_idx').on(table.revision),
  ],
);

export type MedicationScheduleRow = typeof medicationSchedules.$inferSelect;

/**
 * Materialised due doses, the medication counterpart of a check window.
 *
 * `expected` is resolved from the same coverage rules the grid uses, so a dose
 * the family gives is not a dose the team missed (doc 01 §7.2). `status` is
 * derived by the shared state machine on both sides, never invented here.
 */
export const medicationDoses = pgTable(
  'medication_doses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    medicationId: uuid('medication_id')
      .notNull()
      .references(() => medications.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    scheduleId: uuid('schedule_id').references(() => medicationSchedules.id, {
      onDelete: 'set null',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    expected: boolean('expected').notNull().default(true),
    coverageReason: text('coverage_reason'),
    status: doseStatusEnum('status').notNull().default('pending'),
    isLate: boolean('is_late').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // The due list is deterministic, so the materialiser finds the dose it
    // already made rather than laying a second one beside it.
    unique('medication_doses_grid_key').on(table.medicationId, table.dueAt),
    index('medication_doses_participant_idx').on(table.participantId, table.dueAt),
    index('medication_doses_closer_idx').on(table.status, table.dueAt),
    index('medication_doses_revision_idx').on(table.revision),
  ],
);

export type MedicationDoseRow = typeof medicationDoses.$inferSelect;

/**
 * The sign-off. Append-only in effect: nothing here is ever deleted, and the
 * only field that can change afterwards is a PRN outcome that was not known at
 * the time (doc 01 §7.2).
 *
 * `reason_enc` and `outcome_enc` are not in doc 03's column list. Doc 01 §7.2
 * requires both for PRN, and folding three different things into one note
 * column would make the CSV export and the daily report guess which was which
 * (D57).
 */
export const medicationAdministrations = pgTable(
  'medication_administrations',
  {
    /** UUID v7 from the device, so a replay updates rather than duplicates. */
    id: uuid('id').primaryKey(),
    doseId: uuid('dose_id').references(() => medicationDoses.id, { onDelete: 'set null' }),
    medicationId: uuid('medication_id')
      .notNull()
      .references(() => medications.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    status: administrationStatusEnum('status').notNull(),
    /** When the dose was given, which is not when it was typed in. */
    administeredAt: timestamp('administered_at', { withTimezone: true }).notNull(),
    /** Device time at sign-off. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Server time. Authoritative for lateness, because device clocks drift. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * What was actually given, in the worker's words. Plaintext like
     * `medications.dose`, which is the same kind of string, and never computed
     * with (migration 0020).
     */
    amountGiven: text('amount_given'),
    noteEnc: encrypted('note_enc'),
    reasonEnc: encrypted('reason_enc'),
    outcomeEnc: encrypted('outcome_enc'),
    isLate: boolean('is_late').notNull().default(false),
    recordedBy: uuid('recorded_by').references(() => users.id),
    witnessedBy: uuid('witnessed_by').references(() => users.id),
    deviceId: uuid('device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    // One sign-off per scheduled dose. A PRN administration has no dose, and
    // several of them in a day is exactly what PRN means, so the constraint is
    // a partial index rather than a plain unique.
    uniqueIndex('medication_administrations_dose_key')
      .on(table.doseId)
      .where(sql`${table.doseId} is not null`),
    index('medication_administrations_participant_idx').on(
      table.participantId,
      table.administeredAt,
    ),
    index('medication_administrations_medication_idx').on(table.medicationId),
    index('medication_administrations_revision_idx').on(table.revision),
  ],
);

export type MedicationAdministrationRow = typeof medicationAdministrations.$inferSelect;

/**
 * How a device learns to download or purge a participant (doc 03 §11).
 *
 * Written whenever an assignment is granted or revoked. Phase 5 reads it; it is
 * written from here because the assignment service is the only place that knows
 * a scope actually changed, and reconstructing that later from history is
 * guesswork.
 */
export const syncScopeChanges = pgTable(
  'sync_scope_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').notNull(),
    effect: scopeChangeEffectEnum('effect').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('sync_scope_changes_user_idx').on(table.userId),
    index('sync_scope_changes_revision_idx').on(table.revision),
  ],
);

/**
 * Tombstones (doc 03 §11).
 *
 * A device cannot learn about a row that is no longer there: an absent row and
 * an unchanged row look identical through a revision cursor. Almost nothing in
 * Vigilo is hard-deleted, so this table is small. It exists for the one case
 * that is, a future window removed when an admin changes the schedule under
 * it, and for the archived participant whose data a device must drop.
 */
export const syncDeletions = pgTable(
  'sync_deletions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A value from `syncEntities` in @vigilo/shared. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Null only for org-wide reference data. */
    participantId: uuid('participant_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('sync_deletions_revision_idx').on(table.revision),
    index('sync_deletions_participant_idx').on(table.participantId),
  ],
);

/**
 * The idempotency ledger (doc 05 §5).
 *
 * Every operation a device pushes carries a UUID v7 it generated. The first
 * time one arrives it is applied and recorded here; every replay after that
 * returns `duplicate` and touches nothing. This one table is what makes
 * retrying safe on a connection that drops halfway through a response, and it
 * is the single most important property in the sync design.
 */
export const syncAppliedOps = pgTable(
  'sync_applied_ops',
  {
    /** Device-generated. The primary key is the idempotency guarantee. */
    opId: uuid('op_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** A value from `outboxOperationKinds` in @vigilo/shared. */
    kind: text('kind').notNull(),
    /** The row the operation created or changed, for the replay response. */
    entityId: uuid('entity_id'),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sync_applied_ops_applied_idx').on(table.appliedAt)],
);

/**
 * Push, which nothing currently reads or writes (D88).
 *
 * Notifications came out because there is no roster, so there was no honest
 * way to tell a worker on shift from one asleep and everyone assigned was told
 * at any hour. The three tables below stay rather than being dropped: nothing
 * in Vigilo hard-deletes, they hold no participant data, and keeping them means
 * bringing notifications back is writing a sender rather than a migration.
 *
 * If they are still unused when a roster exists, drop them then, deliberately.
 */

/**
 * Web Push endpoints (doc 04 §14). FCM and APNs tokens land in the same table
 * in the native phases, which is why the columns describe a subscription
 * rather than a browser.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** Unique: one subscription per endpoint, re-registered rather than duplicated. */
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    expirationTime: bigint('expiration_time', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /** Set on a 410 from the push service, which means the endpoint is dead. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (table) => [
    index('push_subscriptions_user_idx').on(table.userId),
    index('push_subscriptions_device_idx').on(table.deviceId),
  ],
);

/**
 * Per-kind notification toggles (doc 04 §14). Deliberately not a column on
 * `users`: preferences change often and a user row bumping its revision on
 * every toggle would push a pointless change to every device that can see them.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What a notification has already been sent for.
 *
 * Without this the overdue job would notify about the same window every time
 * it runs. A worker who gets the same alert every five minutes turns
 * notifications off, and then gets none of the ones that matter.
 */
export const notificationsSent = pgTable(
  'notifications_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The window or participant the notification was about. */
    subjectId: uuid('subject_id').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notifications_sent_unique').on(table.userId, table.kind, table.subjectId),
    index('notifications_sent_at_idx').on(table.sentAt),
  ],
);

/**
 * A CSV export that was too big to hand back on the request (doc 01 §8.4).
 *
 * Below the row threshold an export streams straight to the browser. Above it,
 * a request that streams for two minutes is a request a proxy will cut, and a
 * download that dies at 80 percent looks like a smaller export than it was. So
 * it becomes a row here, a file on the attachment volume, and something the
 * browser polls.
 *
 * The file is encrypted at rest like every other file, and holds decrypted
 * participant data, so it is deleted on a short clock rather than kept.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    participantId: uuid('participant_id').references(() => participants.id, {
      onDelete: 'cascade',
    }),
    status: text('status').notNull().default('queued'),
    rowCount: integer('row_count'),
    byteSize: integer('byte_size'),
    /** Relative path on the attachment volume, same store as an attachment. */
    storagePath: text('storage_path'),
    /** Its own data key, wrapped by the master key. */
    dataKeyEnc: encrypted('data_key_enc'),
    error: text('error'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** After this it is deleted, file and row. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('export_jobs_user_idx').on(table.userId, table.requestedAt),
    index('export_jobs_expiry_idx').on(table.expiresAt),
  ],
);

export type ExportJobRow = typeof exportJobs.$inferSelect;

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

/**
 * Passkeys (#24).
 *
 * The authenticator holds the private key and Vigilo holds the public one, so
 * there is nothing here worth stealing: the row cannot sign anything. What it
 * can do is say which account a credential belongs to, which is why
 * `credential_id` is unique across the whole table rather than per user.
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Base64url, as the authenticator reports it. */
    credentialId: text('credential_id').notNull(),
    publicKey: encrypted('public_key').notNull(),
    /**
     * A counter going backwards means a cloned authenticator. Plenty of them
     * report zero forever, so it is a signal and never a gate.
     */
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports'),
    /** True where the authenticator syncs it: the cross-device passkey. */
    backedUp: boolean('backed_up').notNull().default(false),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webauthn_credentials_credential_idx').on(table.credentialId),
    index('webauthn_credentials_user_idx').on(table.userId),
  ],
);

/** The challenge half of both WebAuthn ceremonies. Single use, short lived. */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challenge: text('challenge').notNull(),
    /** Null on a sign-in: a discoverable credential says who it is afterwards. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    deviceId: uuid('device_id'),
    platform: platformEnum('platform'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('webauthn_challenges_challenge_idx').on(table.challenge)],
);

/**
 * Quick sign-in on a device that has already signed in properly (#24).
 *
 * Not a factor by itself (doc 01 §10): the secret is sealed in the device's
 * own secure store behind its fingerprint or a six-digit PIN, and redeeming it
 * returns a session the account already earned. It expires if it is not used,
 * so a phone left in a drawer stops being a way in.
 */
export const deviceCredentials = pgTable(
  'device_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id'),
    /** Argon2, because it is redeemed the same way a password is. */
    secretHash: text('secret_hash').notNull(),
    method: text('method').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('device_credentials_user_idx').on(table.userId)],
);
