import { and, asc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import {
  addDays,
  describeCoverageDecision,
  generateDayWindows,
  hasValue,
  localDateOf,
  nextWindowStatus,
  requiredFieldKeys,
  resolveCoverage,
  backfillNeedsApproval,
  type CheckEntry,
  type CheckValueView,
  type CheckWindow,
  type MissReason,
  type TemplateSchema,
  type WindowDetail,
  type WindowStatus,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  checkEntries,
  checkEntryValues,
  checkSchedules,
  checkTemplates,
  checkTemplateVersions,
  checkWindows,
  missedReasonCodes,
  participants,
  users,
  windowMissReasons,
  type CheckEntryRow,
  type CheckEntryValueRow,
  type CheckWindowRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptOptional } from '../crypto/fields.js';
import { toSegmentInput, activeSchedulesOn } from './schedules.js';
import { loadCoverage } from './coverage.js';
import { publishedVersionFor, parseSchema } from './templates.js';
import { getOrgSettings } from './org.js';
import { recordDeletions } from './tombstones.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Check windows: materialising the grid, closing it, and reading it back
 * (doc 01 §5.3, doc 03 §5).
 *
 * Windows are materialised rather than computed on request for two reasons that
 * both matter. They carry state, and a device with no signal needs a concrete
 * list to work from. Everything here is idempotent, because the materialiser
 * runs hourly and must never lay a second grid over the first.
 */

export const VALUE_TEXT_COLUMN = 'check_entry_values.value_text_enc';
export const MISS_NOTE_COLUMN = 'window_miss_reasons.note_enc';

/** How far ahead the grid is laid down (doc 01 §5.3). */
export const HORIZON_DAYS = 7;

export function toCheckValue(keyRing: KeyRing, row: CheckEntryValueRow): CheckValueView {
  return {
    fieldKey: row.fieldKey,
    number: row.valueNumber === null ? null : Number(row.valueNumber),
    bool: row.valueBool,
    text: decryptOptional(keyRing, VALUE_TEXT_COLUMN, row.valueTextEnc),
    json: (row.valueJson ?? null) as string | string[] | null,
    unit: row.unit,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
  };
}

/**
 * A recorded entry with its values, as every caller wants it.
 *
 * It lives here rather than in entries.ts because entries.ts already imports
 * this module and the reverse would be a cycle. Three places were building
 * this shape by hand, and a fourth arrived with sync.
 */
export async function toCheckEntry(
  db: Database,
  keyRing: KeyRing,
  row: CheckEntryRow,
): Promise<CheckEntry> {
  const values = await db
    .select()
    .from(checkEntryValues)
    .where(eq(checkEntryValues.entryId, row.id))
    .orderBy(asc(checkEntryValues.fieldKey));

  const [recorder] = row.recordedBy
    ? await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, row.recordedBy))
        .limit(1)
    : [];

  return {
    id: row.id,
    windowId: row.windowId,
    participantId: row.participantId,
    templateVersionId: row.templateVersionId,
    recordedBy: row.recordedBy,
    recordedByName: recorder?.displayName ?? null,
    recordedAt: row.recordedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    status: row.status,
    isLate: row.isLate,
    editedAt: row.editedAt?.toISOString() ?? null,
    editCount: row.editCount,
    values: values.map((value) => toCheckValue(keyRing, value)),
  };
}

/**
 * Lays the grid for one participant across a range of local dates.
 *
 * Idempotent by the `(schedule, starts_at, segment)` key: re-running finds the
 * window it already made. Coverage is resolved at insert, and changing coverage
 * later is a separate, previewed and audited recalculation rather than
 * something a background job does silently.
 */
export async function materialiseParticipant(
  db: Database,
  participantId: string,
  fromDate: string,
  toDate: string,
): Promise<{ created: number; skippedUnpublished: number }> {
  const coverage = await loadCoverage(db, participantId);

  let created = 0;
  let skippedUnpublished = 0;
  const versionCache = new Map<string, string | null>();

  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const schedules = await activeSchedulesOn(db, participantId, date);

    for (const { schedule, segments } of schedules) {
      if (segments.length === 0) continue;

      let versionId = versionCache.get(schedule.templateId);
      if (versionId === undefined) {
        versionId = (await publishedVersionFor(db, schedule.templateId))?.id ?? null;
        versionCache.set(schedule.templateId, versionId);
      }
      if (versionId === null) {
        // Nothing to bind a window to. Counted so the job run says so rather
        // than reporting a clean run that produced nothing.
        skippedUnpublished += 1;
        continue;
      }

      const grid = generateDayWindows(segments.map(toSegmentInput), date, coverage.timeZone);
      if (grid.length === 0) continue;

      const rows = grid.map((window) => {
        const decision = resolveCoverage(
          window,
          coverage.ranges,
          coverage.exceptions,
          coverage.timeZone,
        );
        const status: WindowStatus = decision.expected ? 'pending' : 'not_expected';
        return {
          participantId,
          scheduleId: schedule.id,
          segmentId: segments[window.segmentIndex]?.id ?? null,
          templateVersionId: versionId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          expected: decision.expected,
          coverageReason: decision.expected ? null : describeCoverageDecision(decision),
          status,
        };
      });

      const inserted = await db
        .insert(checkWindows)
        .values(rows)
        .onConflictDoNothing({
          target: [checkWindows.scheduleId, checkWindows.startsAt, checkWindows.segmentId],
        })
        .returning({ id: checkWindows.id });

      created += inserted.length;
    }
  }

  return { created, skippedUnpublished };
}

/** Every participant with an active schedule, over the rolling horizon. */
export async function materialiseHorizon(
  db: Database,
  days = HORIZON_DAYS,
): Promise<{ participants: number; created: number; skippedUnpublished: number }> {
  const org = await getOrgSettings(db);
  const today = localDateOf(new Date(), org.timezone);
  const until = addDays(today, days);

  const rows = await db
    .selectDistinct({ participantId: checkSchedules.participantId })
    .from(checkSchedules)
    .innerJoin(participants, eq(participants.id, checkSchedules.participantId))
    .where(and(eq(checkSchedules.status, 'active'), eq(participants.status, 'active')));

  let created = 0;
  let skippedUnpublished = 0;

  for (const row of rows) {
    const result = await materialiseParticipant(db, row.participantId, today, until);
    created += result.created;
    skippedUnpublished += result.skippedUnpublished;
  }

  return { participants: rows.length, created, skippedUnpublished };
}

/**
 * Rebuilds the remaining windows for one schedule after its segments changed.
 *
 * Windows that already hold an entry are preserved and the new grid is not laid
 * over them: the entry keeps its original window (doc 01 §5.3). Generating a
 * fresh window across the same hour would count the check twice in compliance,
 * so overlapping grid slots are skipped rather than added alongside.
 */
export async function regenerateFutureWindows(
  db: Database,
  scheduleId: string,
): Promise<{ removed: number; created: number; preserved: number }> {
  const [schedule] = await db
    .select()
    .from(checkSchedules)
    .where(eq(checkSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) throw new HttpError('not_found', 'That schedule does not exist.');

  const now = new Date();

  // An in-progress window is left alone as well as a recorded one: pulling the
  // grid out from under a worker mid-entry is the fastest way to lose trust.
  const removed = await db
    .delete(checkWindows)
    .where(
      and(
        eq(checkWindows.scheduleId, scheduleId),
        gte(checkWindows.startsAt, now),
        sql`not exists (select 1 from check_entries where check_entries.window_id = ${checkWindows.id})`,
      ),
    )
    .returning({ id: checkWindows.id, participantId: checkWindows.participantId });

  // This is the one place in Vigilo that hard-deletes a row a device holds.
  // Without a tombstone the phone keeps showing a window that no longer exists
  // and lets a worker record against it, and the push then fails with a
  // not_found they cannot act on.
  await recordDeletions(db, 'check_window', removed);

  // Everything left that has not closed yet: the future windows holding an
  // entry, and the one in progress right now. A new grid slot must not be laid
  // across either, or the same hour would be asked for twice and counted twice.
  const preserved = await db
    .select({ startsAt: checkWindows.startsAt, endsAt: checkWindows.endsAt })
    .from(checkWindows)
    .where(and(eq(checkWindows.scheduleId, scheduleId), gt(checkWindows.endsAt, now)));

  const org = await getOrgSettings(db);
  const today = localDateOf(now, org.timezone);
  const until = addDays(today, HORIZON_DAYS);

  const before = await countWindows(db, scheduleId);
  await materialiseSchedule(db, schedule.participantId, scheduleId, today, until, preserved);
  const after = await countWindows(db, scheduleId);

  return { removed: removed.length, created: after - before, preserved: preserved.length };
}

async function countWindows(db: Database, scheduleId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(checkWindows)
    .where(eq(checkWindows.scheduleId, scheduleId));
  return Number(row?.count ?? 0);
}

/** One schedule's slice of the materialiser, with slots to leave untouched. */
async function materialiseSchedule(
  db: Database,
  participantId: string,
  scheduleId: string,
  fromDate: string,
  toDate: string,
  preserved: { startsAt: Date; endsAt: Date }[],
): Promise<void> {
  const coverage = await loadCoverage(db, participantId);

  const [schedule] = await db
    .select({ templateId: checkSchedules.templateId })
    .from(checkSchedules)
    .where(eq(checkSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) return;

  const versionId = (await publishedVersionFor(db, schedule.templateId))?.id;
  if (!versionId) return;

  const now = new Date();

  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const schedules = await activeSchedulesOn(db, participantId, date);
    const match = schedules.find((one) => one.schedule.id === scheduleId);
    if (!match || match.segments.length === 0) continue;

    const grid = generateDayWindows(match.segments.map(toSegmentInput), date, coverage.timeZone);

    const rows = grid
      .filter((window) => window.startsAt >= now)
      .filter(
        (window) =>
          !preserved.some((kept) => window.startsAt < kept.endsAt && kept.startsAt < window.endsAt),
      )
      .map((window) => {
        const decision = resolveCoverage(
          window,
          coverage.ranges,
          coverage.exceptions,
          coverage.timeZone,
        );
        const status: WindowStatus = decision.expected ? 'pending' : 'not_expected';
        return {
          participantId,
          scheduleId,
          segmentId: match.segments[window.segmentIndex]?.id ?? null,
          templateVersionId: versionId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          expected: decision.expected,
          coverageReason: decision.expected ? null : describeCoverageDecision(decision),
          status,
        };
      });

    if (rows.length === 0) continue;

    await db
      .insert(checkWindows)
      .values(rows)
      .onConflictDoNothing({
        target: [checkWindows.scheduleId, checkWindows.startsAt, checkWindows.segmentId],
      });
  }
}

/**
 * The closer (doc 03 §5). Moves open windows to `missed` once they close.
 *
 * `missed` is not the end of the story: a late entry still completes the window
 * and keeps its miss reason, so this only decides what the window looks like
 * right now with nothing further recorded.
 */
export async function closeWindows(db: Database, now = new Date()): Promise<{ closed: number }> {
  const due = await db
    .select({ id: checkWindows.id, endsAt: checkWindows.endsAt, expected: checkWindows.expected })
    .from(checkWindows)
    .where(and(inArray(checkWindows.status, ['pending', 'partial']), lte(checkWindows.endsAt, now)))
    .limit(5000);

  if (due.length === 0) return { closed: 0 };

  const withEntries = await db
    .select({ windowId: checkEntries.windowId, status: checkEntries.status })
    .from(checkEntries)
    .where(
      inArray(
        checkEntries.windowId,
        due.map((one) => one.id),
      ),
    );
  const entryStatus = new Map(withEntries.map((one) => [one.windowId, one.status]));

  const byStatus = new Map<WindowStatus, string[]>();
  for (const window of due) {
    const entry = entryStatus.get(window.id);
    const status = nextWindowStatus({
      expected: window.expected,
      hasEntry: entry !== undefined,
      entryComplete: entry === 'complete',
      endsAt: window.endsAt,
      now,
    });
    const bucket = byStatus.get(status) ?? [];
    bucket.push(window.id);
    byStatus.set(status, bucket);
  }

  let closed = 0;
  for (const [status, ids] of byStatus) {
    await db
      .update(checkWindows)
      .set({ status, updatedAt: now })
      .where(inArray(checkWindows.id, ids));
    closed += ids.length;
  }

  return { closed };
}

/** Recomputes one window after something was recorded against it. */
export async function recomputeWindowStatus(
  db: Database,
  windowId: string,
  now = new Date(),
): Promise<CheckWindowRow> {
  const [window] = await db
    .select()
    .from(checkWindows)
    .where(eq(checkWindows.id, windowId))
    .limit(1);
  if (!window) throw new HttpError('not_found', 'That check window does not exist.');

  const [entry] = await db
    .select()
    .from(checkEntries)
    .where(eq(checkEntries.windowId, windowId))
    .limit(1);

  const status = nextWindowStatus({
    expected: window.expected,
    hasEntry: entry !== undefined,
    entryComplete: entry?.status === 'complete',
    endsAt: window.endsAt,
    now,
  });

  const completedAt = status === 'complete' ? (window.completedAt ?? now) : null;
  const late = entry?.isLate ?? false;

  const [updated] = await db
    .update(checkWindows)
    .set({
      status,
      completedAt,
      isLate: late,
      lateByMinutes: late && entry ? minutesLate(window.endsAt, entry.receivedAt) : null,
      updatedAt: now,
    })
    .where(eq(checkWindows.id, windowId))
    .returning();

  return updated!;
}

function minutesLate(endsAt: Date, receivedAt: Date): number {
  return Math.max(0, Math.ceil((receivedAt.getTime() - endsAt.getTime()) / 60_000));
}

type WindowRowBundle = {
  window: CheckWindowRow;
  scheduleName: string;
  templateName: string;
  entryId: string | null;
  entryStatus: 'partial' | 'complete' | null;
};

async function loadWindowRows(db: Database, where: SQL): Promise<WindowRowBundle[]> {
  const rows = await db
    .select({
      window: checkWindows,
      scheduleName: checkSchedules.name,
      templateName: checkTemplates.name,
      entryId: checkEntries.id,
      entryStatus: checkEntries.status,
    })
    .from(checkWindows)
    .innerJoin(checkSchedules, eq(checkSchedules.id, checkWindows.scheduleId))
    .innerJoin(checkTemplates, eq(checkTemplates.id, checkSchedules.templateId))
    .leftJoin(checkEntries, eq(checkEntries.windowId, checkWindows.id))
    .where(where)
    .orderBy(asc(checkWindows.startsAt));

  return rows.map((row) => ({
    window: row.window,
    scheduleName: row.scheduleName,
    templateName: row.templateName,
    entryId: row.entryId,
    entryStatus: row.entryStatus,
  }));
}

/** Required-field progress for the home screen's bar, per window. */
async function progressFor(
  db: Database,
  bundles: WindowRowBundle[],
): Promise<Map<string, { required: number; filled: number }>> {
  const versionIds = [...new Set(bundles.map((one) => one.window.templateVersionId))];
  const progress = new Map<string, { required: number; filled: number }>();
  if (versionIds.length === 0) return progress;

  const versions = await db
    .select()
    .from(checkTemplateVersions)
    .where(inArray(checkTemplateVersions.id, versionIds));

  const requiredByVersion = new Map<string, string[]>();
  for (const version of versions) {
    requiredByVersion.set(version.id, requiredFieldKeys(parseSchema(version)));
  }

  const entryIds = bundles.map((one) => one.entryId).filter((id): id is string => id !== null);
  const valuesByEntry = new Map<string, CheckEntryValueRow[]>();
  if (entryIds.length > 0) {
    const values = await db
      .select()
      .from(checkEntryValues)
      .where(inArray(checkEntryValues.entryId, entryIds));
    for (const value of values) {
      const bucket = valuesByEntry.get(value.entryId) ?? [];
      bucket.push(value);
      valuesByEntry.set(value.entryId, bucket);
    }
  }

  for (const bundle of bundles) {
    const required = requiredByVersion.get(bundle.window.templateVersionId) ?? [];
    const values = bundle.entryId === null ? [] : (valuesByEntry.get(bundle.entryId) ?? []);
    const answered = new Set(
      values
        .filter((value) =>
          hasValue({
            fieldKey: value.fieldKey,
            number: value.valueNumber === null ? null : Number(value.valueNumber),
            bool: value.valueBool,
            // Presence, not content: the ciphertext being there is the answer.
            text: value.valueTextEnc === null ? null : 'set',
            json: (value.valueJson ?? null) as string | string[] | null,
          }),
        )
        .map((value) => value.fieldKey),
    );

    progress.set(bundle.window.id, {
      required: required.length,
      filled: required.filter((key) => answered.has(key)).length,
    });
  }

  return progress;
}

async function missReasonsFor(
  db: Database,
  keyRing: KeyRing,
  windowIds: string[],
): Promise<Map<string, MissReason>> {
  if (windowIds.length === 0) return new Map();

  const rows = await db
    .select({
      reason: windowMissReasons,
      code: missedReasonCodes.code,
      label: missedReasonCodes.label,
      recordedByName: users.displayName,
    })
    .from(windowMissReasons)
    .innerJoin(missedReasonCodes, eq(missedReasonCodes.id, windowMissReasons.reasonCodeId))
    .leftJoin(users, eq(users.id, windowMissReasons.recordedBy))
    .where(inArray(windowMissReasons.windowId, windowIds));

  return new Map(
    rows.map(({ reason, code, label, recordedByName }) => [
      reason.windowId,
      {
        id: reason.id,
        windowId: reason.windowId,
        reasonCodeId: reason.reasonCodeId,
        code,
        label,
        note: decryptOptional(keyRing, MISS_NOTE_COLUMN, reason.noteEnc),
        recordedBy: reason.recordedBy,
        recordedByName,
        recordedAt: reason.recordedAt.toISOString(),
      },
    ]),
  );
}

async function toCheckWindows(
  db: Database,
  keyRing: KeyRing,
  bundles: WindowRowBundle[],
): Promise<CheckWindow[]> {
  const [progress, reasons] = await Promise.all([
    progressFor(db, bundles),
    missReasonsFor(
      db,
      keyRing,
      bundles.map((one) => one.window.id),
    ),
  ]);

  return bundles.map((bundle) => {
    const counts = progress.get(bundle.window.id) ?? { required: 0, filled: 0 };
    return {
      id: bundle.window.id,
      participantId: bundle.window.participantId,
      scheduleId: bundle.window.scheduleId,
      scheduleName: bundle.scheduleName,
      segmentId: bundle.window.segmentId,
      templateVersionId: bundle.window.templateVersionId,
      templateName: bundle.templateName,
      startsAt: bundle.window.startsAt.toISOString(),
      endsAt: bundle.window.endsAt.toISOString(),
      expected: bundle.window.expected,
      coverageReason: bundle.window.coverageReason,
      status: bundle.window.status,
      completedAt: bundle.window.completedAt?.toISOString() ?? null,
      isLate: bundle.window.isLate,
      lateByMinutes: bundle.window.lateByMinutes,
      requiredFieldCount: counts.required,
      filledRequiredCount: counts.filled,
      entryId: bundle.entryId,
      missReason: reasons.get(bundle.window.id) ?? null,
    };
  });
}

export async function listWindows(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: Date,
  to: Date,
): Promise<CheckWindow[]> {
  const bundles = await loadWindowRows(
    db,
    and(
      eq(checkWindows.participantId, participantId),
      gte(checkWindows.startsAt, from),
      lt(checkWindows.startsAt, to),
    )!,
  );
  return toCheckWindows(db, keyRing, bundles);
}

/** Windows by id, for a sync page. Same DTO the Today screen renders. */
export async function windowsByIds(
  db: Database,
  keyRing: KeyRing,
  ids: readonly string[],
): Promise<CheckWindow[]> {
  if (ids.length === 0) return [];
  const bundles = await loadWindowRows(db, inArray(checkWindows.id, [...ids]));
  return toCheckWindows(db, keyRing, bundles);
}

/** Miss reasons by window id, for a sync page. */
export async function missReasonsByWindowIds(
  db: Database,
  keyRing: KeyRing,
  windowIds: readonly string[],
): Promise<MissReason[]> {
  return [...(await missReasonsFor(db, keyRing, [...windowIds])).values()];
}

export async function findWindow(db: Database, id: string): Promise<CheckWindowRow> {
  const [row] = await db.select().from(checkWindows).where(eq(checkWindows.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That check window does not exist.');
  return row;
}

/** The window, its frozen schema and the entry so far. The form's whole input. */
export async function getWindowDetail(
  db: Database,
  keyRing: KeyRing,
  windowId: string,
): Promise<WindowDetail> {
  const bundles = await loadWindowRows(db, and(eq(checkWindows.id, windowId))!);
  const bundle = bundles[0];
  if (!bundle) throw new HttpError('not_found', 'That check window does not exist.');

  const [summary] = await toCheckWindows(db, keyRing, bundles);
  const [version] = await db
    .select()
    .from(checkTemplateVersions)
    .where(eq(checkTemplateVersions.id, bundle.window.templateVersionId))
    .limit(1);

  const schema: TemplateSchema = version ? parseSchema(version) : { fields: [] };

  let entry: unknown = null;
  if (bundle.entryId !== null) {
    const [row] = await db
      .select()
      .from(checkEntries)
      .where(eq(checkEntries.id, bundle.entryId))
      .limit(1);
    entry = row ? await toCheckEntry(db, keyRing, row) : null;
  }

  const org = await getOrgSettings(db);

  return {
    ...summary!,
    templateSchema: schema,
    entryStatus: bundle.entryStatus,
    entry,
    backfillNeedsApproval: backfillNeedsApproval(
      bundle.window.endsAt,
      new Date(),
      org.lateEntryCutoffMinutes,
    ),
  };
}

/**
 * Every window across the caller's participants closing soon, which is what the
 * Today screen runs on (doc 04 §7). Anything still needing a miss reason comes
 * with it, because that sits above everything else on that screen.
 */
export async function dueWindows(
  db: Database,
  keyRing: KeyRing,
  participantIds: string[] | 'all',
  options: { withinMinutes?: number; lookBackHours?: number } = {},
): Promise<CheckWindow[]> {
  const now = new Date();
  const until = new Date(now.getTime() + (options.withinMinutes ?? 12 * 60) * 60_000);
  const since = new Date(now.getTime() - (options.lookBackHours ?? 48) * 3_600_000);

  const filters = [gte(checkWindows.endsAt, since), lt(checkWindows.startsAt, until)];
  if (participantIds !== 'all') {
    if (participantIds.length === 0) return [];
    filters.push(inArray(checkWindows.participantId, participantIds));
  }

  const bundles = await loadWindowRows(db, and(...filters)!);
  return toCheckWindows(db, keyRing, bundles);
}

/** Windows still open right now, used to decide what a worker is asked for. */
export async function openWindowCount(db: Database, participantId: string): Promise<number> {
  const now = new Date();
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(checkWindows)
    .where(
      and(
        eq(checkWindows.participantId, participantId),
        inArray(checkWindows.status, ['pending', 'partial']),
        gt(checkWindows.endsAt, now),
      ),
    );
  return Number(row?.count ?? 0);
}
