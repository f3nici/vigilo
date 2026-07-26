import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 0 schema (doc 03 §1 and §10).
 *
 * Only the two foundational tables exist yet: org-wide settings and job run
 * records. Users, participants and everything clinical arrive in Phase 1 and
 * later, behind the scope resolver and the encryption layer.
 */

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

/** So a cron that stopped firing is visible rather than silent (doc 02 §6). */
export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobName: text('job_name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
});

export type JobRun = typeof jobRuns.$inferSelect;
