import { z } from 'zod';
import {
  checkEntrySchema,
  missReasonSchema,
  missedReasonCodeSchema,
  putEntryRequestSchema,
  recordUnscheduledCheckRequestSchema,
  putMissReasonRequestSchema,
} from './checks.js';
import { checkTemplateSchema, templateVersionSchema } from './templates.js';
import { checkScheduleSchema } from './schedules.js';
import { carePlanSchema, markCarePlanReadRequestSchema } from './careplans.js';
import {
  medicationAdministrationSchema,
  medicationDoseSchema,
  medicationSchema,
  recordPrnRequestSchema,
  signOffRequestSchema,
} from './medications.js';
import { checkWindowSchema } from './windows.js';
import {
  createDiaryEntryRequestSchema,
  diaryCategorySchema,
  diaryEntrySchema,
  updateDiaryEntryRequestSchema,
} from './diary.js';
import { attachmentSchema, createAttachmentRequestSchema } from './attachments.js';
import {
  alertSchema,
  emergencyContactSchema,
  emergencyPlanSchema,
  participantSummarySchema,
} from './participants.js';
import { errorCodeSchema } from './errors.js';

/**
 * The sync contract (doc 04 §13, doc 05).
 *
 * Both sides import this file. The server produces these shapes, the device
 * stores them, and the two cannot drift because there is only one definition.
 * That matters more here than anywhere else in the codebase: a device and a
 * server that disagree about what a change looks like lose clinical records.
 *
 * Rows on the wire are the same DTOs the REST endpoints already return. There
 * is no second serialisation for sync, so a window that renders correctly
 * online renders correctly from the local database too.
 */

/* ---------------------------------------------------------------- entities */

/**
 * Everything a device holds. Order matters: a page is applied in this order so
 * a row never lands before the row it points at. Categories before diary
 * entries, template versions before windows, windows before entries.
 *
 * Coverage patterns and exceptions are deliberately absent, though doc 05 §3
 * lists them. A window arrives with `expected` and `coverageReason` already
 * resolved by the server, so the rules that produced them would only give the
 * device a second way to answer a question the server has already answered.
 * Two answers that can disagree is the exact failure CLAUDE.md forbids (D45).
 */
export const syncEntities = [
  'participant',
  'participant_alert',
  'emergency_contact',
  'emergency_plan',
  'check_template',
  'check_template_version',
  'check_schedule',
  'care_plan',
  'medication',
  'missed_reason_code',
  'diary_category',
  'check_window',
  'check_entry',
  'window_miss_reason',
  'medication_dose',
  'medication_administration',
  'diary_entry',
  'attachment',
] as const;

export const syncEntitySchema = z.enum(syncEntities);
export type SyncEntity = z.infer<typeof syncEntitySchema>;

const applyOrder = new Map<SyncEntity, number>(syncEntities.map((name, index) => [name, index]));

/**
 * Sorts a page for local application: by revision, then by the entity order
 * above so a diary entry never arrives before its category.
 */
export function sortForApply<T extends { entity: SyncEntity; revision: number }>(
  changes: readonly T[],
): T[] {
  return [...changes].sort((a, b) => {
    if (a.revision !== b.revision) return a.revision - b.revision;
    return (applyOrder.get(a.entity) ?? 0) - (applyOrder.get(b.entity) ?? 0);
  });
}

/**
 * Reference data belongs to the whole organisation rather than one person, so
 * it has no participant id and is never dropped by a scope revocation.
 */
export function isOrgWideEntity(entity: SyncEntity): boolean {
  return (
    entity === 'check_template' ||
    entity === 'check_template_version' ||
    entity === 'missed_reason_code' ||
    entity === 'diary_category'
  );
}

/* ---------------------------------------------------------------- devices */

export const devicePlatforms = ['android', 'ios', 'web'] as const;
export const devicePlatformSchema = z.enum(devicePlatforms);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/**
 * A device announcing itself.
 *
 * The id is generated on the device and kept, so the same phone is the same
 * row across sign-ins. That is what lets a push subscription, a sync cursor
 * and a remote wipe flag all refer to one thing.
 */
export const registerDeviceRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    platform: devicePlatformSchema,
    model: z.string().trim().max(120).nullable().default(null),
    osVersion: z.string().trim().max(60).nullable().default(null),
    appVersion: z.string().trim().max(60).nullable().default(null),
    /** True when running from the home screen rather than a browser tab. */
    installed: z.boolean().default(false),
  })
  .strict();

export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const deviceSchema = z.object({
  id: z.string(),
  platform: devicePlatformSchema,
  lastSyncAt: z.string().nullable(),
  lastSyncRevision: z.number().nullable(),
  /**
   * Set when the account was suspended or the device was lost. The device
   * wipes its local database at next contact, after flushing its outbox.
   */
  wipeRequested: z.boolean(),
});

export type Device = z.infer<typeof deviceSchema>;

/* ------------------------------------------------------------------- pull */

/**
 * One row, in whatever DTO shape its entity uses.
 *
 * Discriminated on `entity`, so applying a page gives the device a typed row
 * per branch rather than an unknown it has to cast. The envelope fields are
 * spelled out once and reused, which is the only reason a sixteen-branch union
 * is readable.
 */
function change<E extends SyncEntity, R extends z.ZodTypeAny>(entity: E, row: R) {
  return z.object({
    entity: z.literal(entity),
    id: z.string(),
    /** Null for org-wide reference data, which no revocation drops. */
    participantId: z.string().nullable(),
    revision: z.number(),
    row,
  });
}

export const syncChangeSchema = z.discriminatedUnion('entity', [
  change('participant', participantSummarySchema),
  change('participant_alert', alertSchema),
  change('emergency_contact', emergencyContactSchema),
  change('emergency_plan', emergencyPlanSchema),
  change('check_template', checkTemplateSchema),
  change('check_template_version', templateVersionSchema),
  change('check_schedule', checkScheduleSchema),
  change('care_plan', carePlanSchema),
  change('medication', medicationSchema),
  change('missed_reason_code', missedReasonCodeSchema),
  change('diary_category', diaryCategorySchema),
  change('check_window', checkWindowSchema),
  change('check_entry', checkEntrySchema),
  change('window_miss_reason', missReasonSchema),
  change('medication_dose', medicationDoseSchema),
  change('medication_administration', medicationAdministrationSchema),
  change('diary_entry', diaryEntrySchema),
  change('attachment', attachmentSchema),
]);

export type SyncChange = z.infer<typeof syncChangeSchema>;

/**
 * A deletion. An absent row is indistinguishable from an unchanged one, so
 * removals travel as their own record (doc 05 §4).
 */
export const syncTombstoneSchema = z.object({
  entity: syncEntitySchema,
  id: z.string(),
  participantId: z.string().nullable(),
  deletedAt: z.string(),
  revision: z.number(),
});

export type SyncTombstone = z.infer<typeof syncTombstoneSchema>;

export const syncScopeChangeSchema = z.object({
  participantId: z.string(),
  effect: z.enum(['granted', 'revoked']),
  at: z.string(),
  revision: z.number(),
});

export type SyncScopeChange = z.infer<typeof syncScopeChangeSchema>;

export const syncChangesResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  tombstones: z.array(syncTombstoneSchema),
  scopeChanges: z.array(syncScopeChangeSchema),
  /** The cursor to store once the whole page has been applied. */
  nextRevision: z.number(),
  hasMore: z.boolean(),
  /**
   * The head of the global sequence right now, whatever this page contains.
   *
   * This is what makes a database restore detectable. `nextRevision` cannot do
   * it: an empty page leaves the cursor where it was, so a device asking from
   * a revision the server has never issued would get its own number back and
   * conclude it was up to date.
   */
  serverRevision: z.number(),
  /** Server time, so the device can measure its own clock skew. */
  serverTime: z.string(),
});

export type SyncChangesResponse = z.infer<typeof syncChangesResponseSchema>;

export const syncBootstrapResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  /** Everything at or below this revision is already in `changes`. */
  revision: z.number(),
  serverTime: z.string(),
  timeZone: z.string(),
  /** The participants in scope right now, so the device can drop the rest. */
  participantIds: z.array(z.string()),
  retentionDays: z.number(),
});

export type SyncBootstrapResponse = z.infer<typeof syncBootstrapResponseSchema>;

/** One page. Large enough to be worth a round trip, small enough to redo. */
export const SYNC_PAGE_LIMIT = 500;
export const SYNC_PAGE_MAX = 1000;

export const syncChangesQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(SYNC_PAGE_MAX).default(SYNC_PAGE_LIMIT),
});

export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;

/**
 * A `nextRevision` below the cursor the device already holds means the
 * sequence went backwards, which only happens when the database was restored
 * from a backup. Walking on from the old cursor would silently skip everything
 * written since, so the device throws its local copy away and bootstraps
 * (doc 05 §10).
 */
export function needsBootstrap(cursor: number, serverRevision: number): boolean {
  return serverRevision < cursor;
}

/* ------------------------------------------------------------------- push */

/**
 * What a device may send up.
 *
 * Only the five things doc 05 §3 marks as flowing both ways. Windows,
 * schedules, coverage and templates are server-authored and deliberately have
 * no operation here: a device that could create a window could invent a
 * schedule, and the fixed grid is the whole point.
 */
export const outboxOperationKinds = [
  'check_entry.put',
  'check.unscheduled',
  'miss_reason.put',
  'medication.sign_off',
  'medication.prn',
  'care_plan.read',
  'diary_entry.create',
  'diary_entry.update',
  'attachment.create',
] as const;

export const outboxOperationKindSchema = z.enum(outboxOperationKinds);
export type OutboxOperationKind = z.infer<typeof outboxOperationKindSchema>;

export const outboxOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    /** UUID v7, generated on the device. The whole idempotency story. */
    opId: z.string().uuid(),
    kind: z.literal('check_entry.put'),
    participantId: z.string().uuid(),
    /**
     * Null when the device has no window for the moment being recorded, after
     * more than seven days offline. The server binds it by timestamp on
     * arrival rather than refusing the record (doc 05 §3).
     */
    windowId: z.string().uuid().nullable(),
    payload: putEntryRequestSchema,
  }),
  /*
   * A check nobody scheduled (D89). No window id, and none is bound on arrival
   * either: this one never had a window and the server must not invent one for
   * it, or a check somebody chose to take would land in a slot the schedule
   * asked for and be counted as answering it.
   *
   * The same shape as `medication.prn`, which is the same idea one table over.
   */
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('check.unscheduled'),
    participantId: z.string().uuid(),
    payload: recordUnscheduledCheckRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('miss_reason.put'),
    participantId: z.string().uuid(),
    windowId: z.string().uuid(),
    payload: putMissReasonRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('medication.sign_off'),
    participantId: z.string().uuid(),
    /**
     * Never null, unlike a check entry's window.
     *
     * A worker who runs out of materialised windows can still record a check
     * against the clock, and the server binds it by timestamp. A dose cannot
     * work that way: binding by timestamp would mean guessing which medication
     * was given, and a guess about which drug reached a person is not a guess
     * software gets to make. Out of doses, the PRN path or a note is the
     * honest answer.
     */
    doseId: z.string().uuid(),
    payload: signOffRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('medication.prn'),
    participantId: z.string().uuid(),
    payload: recordPrnRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('care_plan.read'),
    participantId: z.string().uuid(),
    carePlanId: z.string().uuid(),
    payload: markCarePlanReadRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('diary_entry.create'),
    participantId: z.string().uuid(),
    payload: createDiaryEntryRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('diary_entry.update'),
    participantId: z.string().uuid(),
    entryId: z.string().uuid(),
    payload: updateDiaryEntryRequestSchema,
  }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('attachment.create'),
    participantId: z.string().uuid(),
    payload: createAttachmentRequestSchema,
  }),
]);

export type OutboxOperation = z.infer<typeof outboxOperationSchema>;

/** Batches of 50. One rejected operation must not block the other 49. */
export const SYNC_PUSH_BATCH = 50;

export const syncPushRequestSchema = z.object({
  operations: z.array(outboxOperationSchema).min(1).max(SYNC_PUSH_BATCH),
  /** Device clock at send time, so skew is measured on real traffic. */
  sentAt: z.string().datetime({ offset: true }).optional(),
});

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncPushResultSchema = z.discriminatedUnion('status', [
  z.object({ opId: z.string(), status: z.literal('applied'), revision: z.number() }),
  z.object({ opId: z.string(), status: z.literal('duplicate'), revision: z.number() }),
  z.object({
    opId: z.string(),
    status: z.literal('rejected'),
    error: z.object({ code: errorCodeSchema, message: z.string() }),
  }),
]);

export type SyncPushResult = z.infer<typeof syncPushResultSchema>;

export const syncPushResponseSchema = z.object({
  results: z.array(syncPushResultSchema),
  serverRevision: z.number(),
  serverTime: z.string(),
});

export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

/**
 * What the device does with each result.
 *
 * `applied` and `duplicate` both mean the server holds the record, so both
 * clear the outbox row. That equivalence is the whole reason retrying is safe
 * (doc 05 §5).
 */
export function outboxDisposition(result: SyncPushResult): 'clear' | 'needs_user' {
  return result.status === 'rejected' ? 'needs_user' : 'clear';
}

/* ---------------------------------------------------------------- retries */

/**
 * 5s, 15s, 1m, 5m, 15m, then hourly (doc 05 §5).
 *
 * Jitter is applied separately by the caller with its own random source, so
 * this stays pure and stays testable.
 */
const backoffSteps = [5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000] as const;

export const BACKOFF_STEP_COUNT = backoffSteps.length;

export function backoffDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const index = Math.min(attempts, backoffSteps.length) - 1;
  return backoffSteps[index] ?? 3_600_000;
}

/** Half to full jitter, so 300 devices back on one tower do not retry in step. */
export function withJitter(delayMs: number, random: () => number): number {
  return Math.round(delayMs * (0.5 + random() * 0.5));
}

/**
 * After a day of failing, retrying quietly is the wrong answer. The operation
 * is surfaced to the user, because at that point something is wrong that only
 * a person can resolve (doc 05 §5).
 */
export const RETRY_SURFACE_AFTER_MS = 24 * 60 * 60 * 1000;

export function shouldSurfaceToUser(firstAttemptAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(firstAttemptAt) >= RETRY_SURFACE_AFTER_MS;
}

/* --------------------------------------------------------------- indicator */

/**
 * Outbox age past which the user is warned (doc 05 §8.1). Chosen to match iOS
 * eviction risk: anything sitting unsent for a day is at real risk of being
 * destroyed by the browser, and the user is the only one who can act on it.
 */
export const OUTBOX_STALE_WARNING_MS = 24 * 60 * 60 * 1000;

export type SyncIndicatorState = 'synced' | 'pending' | 'offline' | 'needs_attention';

export type SyncStatus = {
  online: boolean;
  pendingCount: number;
  needsUserCount: number;
  /** ISO time of the oldest queued operation, null when the queue is empty. */
  oldestPendingAt: string | null;
  lastSyncAt: string | null;
};

export function syncIndicatorState(status: SyncStatus, now: Date): SyncIndicatorState {
  if (status.needsUserCount > 0) return 'needs_attention';
  if (status.oldestPendingAt !== null) {
    const age = now.getTime() - Date.parse(status.oldestPendingAt);
    if (age >= OUTBOX_STALE_WARNING_MS) return 'needs_attention';
  }
  if (status.pendingCount > 0) return status.online ? 'pending' : 'offline';
  return status.online ? 'synced' : 'offline';
}

/**
 * The words on the indicator. Being offline is a fact, not an error, so it
 * never reads as a failure (doc 06 §7).
 */
export function describeSyncState(status: SyncStatus, now: Date): string {
  const state = syncIndicatorState(status, now);
  switch (state) {
    case 'needs_attention':
      if (status.needsUserCount > 0) {
        return status.needsUserCount === 1
          ? '1 record needs attention'
          : `${status.needsUserCount} records need attention`;
      }
      return 'Waiting to send for over a day';
    case 'pending':
      return status.pendingCount === 1
        ? 'Sending 1 record'
        : `Sending ${status.pendingCount} records`;
    case 'offline':
      if (status.pendingCount === 0) return 'Offline, everything saved';
      return status.pendingCount === 1
        ? 'Offline, 1 record waiting'
        : `Offline, ${status.pendingCount} records waiting`;
    case 'synced':
      return 'Synced';
  }
}

/* --------------------------------------------------------------- retention */

/**
 * What a device keeps (doc 05 §4). Anything older is fetched on demand and
 * needs a connection, which keeps the local database small and bounds how long
 * a bootstrap takes on a phone.
 */
export const DEVICE_WINDOW_DAYS_BACK = 7;
export const DEVICE_WINDOW_DAYS_FORWARD = 7;
export const DEVICE_RECORD_RETENTION_DAYS = 30;

/** No successful sync for this long and the local database is wiped. */
export const DEVICE_WIPE_AFTER_DAYS = 30;

export function isBeyondDeviceRetention(recordedAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(recordedAt);
  return age > DEVICE_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------- clock skew */

/**
 * Beyond this the user is told their device clock is wrong (doc 05 §6). The
 * record still keeps device time; only the warning is triggered here, because
 * lateness is always computed from server time.
 */
export const CLOCK_SKEW_WARNING_MS = 5 * 60 * 1000;

export function clockSkewIsSignificant(skewMs: number): boolean {
  return Math.abs(skewMs) >= CLOCK_SKEW_WARNING_MS;
}
