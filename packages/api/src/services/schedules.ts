import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  describeCoverageDecision,
  generateDayWindows,
  resolveCoverage,
  segmentInputSchema,
  validateSegments,
  type CheckSchedule,
  type CreateScheduleRequest,
  type PreviewScheduleRequest,
  type PutSegmentsRequest,
  type SchedulePreview,
  type ScheduleSegment,
  type SegmentInput,
  type UpdateScheduleRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  checkEntries,
  checkSchedules,
  checkScheduleSegments,
  checkTemplates,
  checkWindows,
  type CheckScheduleRow,
  type CheckScheduleSegmentRow,
} from '../db/schema.js';
import { publishedVersionFor } from './templates.js';
import { loadCoverage } from './coverage.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Check schedules and their segments (doc 03 §5, doc 04 §6).
 *
 * The grid arithmetic is in @vigilo/shared, and both the preview here and the
 * materialiser call the same function. What an admin sees before saving is
 * produced by the code that will produce the real windows.
 *
 * Segments are replaced as a set, never one at a time, because overlap is a
 * property of the set. Validating a half-applied set would either refuse a
 * legal end state or accept an illegal one depending on the order of the edits.
 */

function toTimeOfDay(value: string): string {
  return value.slice(0, 5);
}

function toDbTime(value: string): string {
  return `${value}:00`;
}

export function toSegmentInput(row: CheckScheduleSegmentRow): SegmentInput {
  return {
    windowMinutes: row.windowMinutes,
    anchorTime: toTimeOfDay(row.anchorTime),
    appliesFromTime: toTimeOfDay(row.appliesFromTime),
    appliesToTime: toTimeOfDay(row.appliesToTime),
    weekdays: row.weekdays ?? null,
    sortOrder: row.sortOrder,
    label: row.label,
  };
}

function toSegment(row: CheckScheduleSegmentRow): ScheduleSegment {
  return { id: row.id, ...toSegmentInput(row) };
}

export type ScheduleWithSegments = {
  schedule: CheckScheduleRow;
  segments: CheckScheduleSegmentRow[];
};

async function segmentsFor(
  db: Database,
  scheduleIds: string[],
): Promise<Map<string, CheckScheduleSegmentRow[]>> {
  if (scheduleIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(checkScheduleSegments)
    .where(inArray(checkScheduleSegments.scheduleId, scheduleIds))
    .orderBy(asc(checkScheduleSegments.sortOrder), asc(checkScheduleSegments.appliesFromTime));

  const grouped = new Map<string, CheckScheduleSegmentRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.scheduleId) ?? [];
    bucket.push(row);
    grouped.set(row.scheduleId, bucket);
  }
  return grouped;
}

async function assemble(db: Database, rows: CheckScheduleRow[]): Promise<CheckSchedule[]> {
  if (rows.length === 0) return [];

  const templateIds = [...new Set(rows.map((row) => row.templateId))];
  const [segments, templates] = await Promise.all([
    segmentsFor(
      db,
      rows.map((row) => row.id),
    ),
    db
      .select({ id: checkTemplates.id, name: checkTemplates.name })
      .from(checkTemplates)
      .where(inArray(checkTemplates.id, templateIds)),
  ]);

  const names = new Map(templates.map((one) => [one.id, one.name]));
  const published = new Map<string, string | null>();
  for (const templateId of templateIds) {
    const version = await publishedVersionFor(db, templateId);
    published.set(templateId, version?.id ?? null);
  }

  return rows.map((row) => ({
    id: row.id,
    participantId: row.participantId,
    templateId: row.templateId,
    templateName: names.get(row.templateId) ?? 'Unknown form',
    publishedVersionId: published.get(row.templateId) ?? null,
    name: row.name,
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    status: row.status,
    segments: (segments.get(row.id) ?? []).map(toSegment),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listSchedules(
  db: Database,
  participantId: string,
  options: { includeEnded?: boolean } = {},
): Promise<CheckSchedule[]> {
  const filters = [eq(checkSchedules.participantId, participantId)];
  if (!options.includeEnded) {
    filters.push(inArray(checkSchedules.status, ['active', 'paused']));
  }

  const rows = await db
    .select()
    .from(checkSchedules)
    .where(and(...filters))
    .orderBy(asc(checkSchedules.name));

  return assemble(db, rows);
}

export async function findSchedule(db: Database, id: string): Promise<CheckScheduleRow> {
  const [row] = await db.select().from(checkSchedules).where(eq(checkSchedules.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That schedule does not exist.');
  return row;
}

export async function getSchedule(db: Database, id: string): Promise<CheckSchedule> {
  const row = await findSchedule(db, id);
  const [schedule] = await assemble(db, [row]);
  return schedule!;
}

/** Active schedules that apply on a given local date, with their segments. */
export async function activeSchedulesOn(
  db: Database,
  participantId: string,
  isoDate: string,
): Promise<ScheduleWithSegments[]> {
  const rows = await db
    .select()
    .from(checkSchedules)
    .where(
      and(
        eq(checkSchedules.participantId, participantId),
        eq(checkSchedules.status, 'active'),
        sql`${checkSchedules.activeFrom} <= ${isoDate}::date`,
        or(isNull(checkSchedules.activeTo), sql`${checkSchedules.activeTo} >= ${isoDate}::date`),
      ),
    );

  const segments = await segmentsFor(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((schedule) => ({ schedule, segments: segments.get(schedule.id) ?? [] }));
}

function assertSegmentsValid(segments: SegmentInput[]): void {
  const { problems } = validateSegments(segments);
  if (problems.length > 0) {
    throw new HttpError('validation_failed', problems[0]!.message, { problems });
  }
}

export async function createSchedule(
  db: Database,
  participantId: string,
  request: CreateScheduleRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<CheckSchedule> {
  assertSegmentsValid(request.segments);

  // A schedule with no published version has nothing to bind a window to, so
  // it would materialise nothing and look broken rather than empty.
  const version = await publishedVersionFor(db, request.templateId);
  if (!version) {
    throw new HttpError(
      'conflict',
      'That check form has not been published yet. Publish it before scheduling it.',
    );
  }

  const created = await db.transaction(async (tx) => {
    const [schedule] = await tx
      .insert(checkSchedules)
      .values({
        participantId,
        templateId: request.templateId,
        name: request.name,
        activeFrom: request.activeFrom,
        activeTo: request.activeTo ?? null,
        createdBy,
      })
      .returning();

    await tx.insert(checkScheduleSegments).values(
      request.segments.map((segment) => ({
        scheduleId: schedule!.id,
        label: segment.label,
        windowMinutes: segment.windowMinutes,
        anchorTime: toDbTime(segment.anchorTime),
        appliesFromTime: toDbTime(segment.appliesFromTime),
        appliesToTime: toDbTime(segment.appliesToTime),
        weekdays: segment.weekdays,
        sortOrder: segment.sortOrder,
      })),
    );

    return schedule!;
  });

  await recordAudit(db, {
    action: 'schedule.create',
    actor,
    entityType: 'check_schedule',
    entityId: created.id,
    participantId,
    metadata: { segmentCount: request.segments.length },
  });

  return getSchedule(db, created.id);
}

export async function updateSchedule(
  db: Database,
  id: string,
  request: UpdateScheduleRequest,
  actor: AuditActor,
): Promise<CheckSchedule> {
  const existing = await findSchedule(db, id);

  const changes: Partial<typeof checkSchedules.$inferInsert> = { updatedAt: new Date() };
  if (request.name !== undefined) changes.name = request.name;
  if (request.activeFrom !== undefined) changes.activeFrom = request.activeFrom;
  if ('activeTo' in request) changes.activeTo = request.activeTo ?? null;
  if (request.status !== undefined) changes.status = request.status;

  await db.update(checkSchedules).set(changes).where(eq(checkSchedules.id, id));

  await recordAudit(db, {
    action: 'schedule.update',
    actor,
    entityType: 'check_schedule',
    entityId: id,
    participantId: existing.participantId,
    // Before and after, because a schedule change moves when checks are due
    // and doc 01 §5.3 requires both sides on the record.
    metadata: {
      before: {
        name: existing.name,
        activeFrom: existing.activeFrom,
        activeTo: existing.activeTo,
        status: existing.status,
      },
      after: { ...request },
    },
  });

  return getSchedule(db, id);
}

/**
 * Replaces the segment set atomically. Returns the schedule; regenerating the
 * affected windows is the caller's next step, so the audit row and the
 * regeneration count stay together at the route.
 */
export async function putSegments(
  db: Database,
  id: string,
  request: PutSegmentsRequest,
  actor: AuditActor,
): Promise<CheckSchedule> {
  const existing = await findSchedule(db, id);
  assertSegmentsValid(request.segments);

  await db.transaction(async (tx) => {
    // Deleting a segment sets segment_id to null on any window it produced, so
    // a recorded check keeps its window even after the rule that made it is
    // gone. The window itself is only removed if it is in the future and empty.
    await tx.delete(checkScheduleSegments).where(eq(checkScheduleSegments.scheduleId, id));

    await tx.insert(checkScheduleSegments).values(
      request.segments.map((segment) => ({
        scheduleId: id,
        label: segment.label,
        windowMinutes: segment.windowMinutes,
        anchorTime: toDbTime(segment.anchorTime),
        appliesFromTime: toDbTime(segment.appliesFromTime),
        appliesToTime: toDbTime(segment.appliesToTime),
        weekdays: segment.weekdays,
        sortOrder: segment.sortOrder,
      })),
    );

    await tx.update(checkSchedules).set({ updatedAt: new Date() }).where(eq(checkSchedules.id, id));
  });

  await recordAudit(db, {
    action: 'schedule.segments_update',
    actor,
    entityType: 'check_schedule',
    entityId: id,
    participantId: existing.participantId,
    metadata: { segmentCount: request.segments.length },
  });

  return getSchedule(db, id);
}

/** Ends a schedule. Past windows stay; future empty ones are cleared away. */
export async function endSchedule(
  db: Database,
  id: string,
  actor: AuditActor,
): Promise<CheckSchedule> {
  const existing = await findSchedule(db, id);

  await db
    .update(checkSchedules)
    .set({ status: 'ended', updatedAt: new Date() })
    .where(eq(checkSchedules.id, id));

  await recordAudit(db, {
    action: 'schedule.end',
    actor,
    entityType: 'check_schedule',
    entityId: id,
    participantId: existing.participantId,
  });

  return getSchedule(db, id);
}

/**
 * The live preview (doc 04 §6, doc 06 §5). **Saves nothing.**
 *
 * Takes a candidate segment set rather than the stored one, so the admin sees
 * the result of what they are typing before they commit to it, overlaid with
 * coverage so the two jobs visibly meet on one screen.
 */
export async function previewSchedule(
  db: Database,
  participantId: string,
  request: PreviewScheduleRequest,
  scheduleId: string | null,
): Promise<SchedulePreview> {
  const segments = request.segments.map((segment) => segmentInputSchema.parse(segment));
  const { problems, warnings } = validateSegments(segments);
  const coverage = await loadCoverage(db, participantId);

  const windows =
    problems.length > 0 ? [] : generateDayWindows(segments, request.date, coverage.timeZone);

  const previewWindows = windows.map((window) => {
    const decision = resolveCoverage(
      window,
      coverage.ranges,
      coverage.exceptions,
      coverage.timeZone,
    );
    return {
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      startMinutes: window.startMinutes,
      endMinutes: window.endMinutes,
      segmentIndex: window.segmentIndex,
      expected: decision.expected,
      coverageReason: decision.expected ? null : describeCoverageDecision(decision),
    };
  });

  // What saving would disturb. Counted against the stored windows, not the
  // candidate ones, because that is the question the admin is really asking.
  let windowsToRegenerate = 0;
  let entriesAffected = 0;

  if (scheduleId !== null) {
    const now = new Date();
    // Windows that have not closed yet, which is what saving would touch.
    // Anything already closed is history and is never regenerated.
    const remaining = await db
      .select({ id: checkWindows.id, entryId: checkEntries.id })
      .from(checkWindows)
      .leftJoin(checkEntries, eq(checkEntries.windowId, checkWindows.id))
      .where(and(eq(checkWindows.scheduleId, scheduleId), gt(checkWindows.endsAt, now)));

    for (const row of remaining) {
      if (row.entryId === null) windowsToRegenerate += 1;
      else entriesAffected += 1;
    }
  }

  const allWarnings: SchedulePreview['warnings'] = warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    segmentIndex: warning.segmentIndex,
  }));

  if (entriesAffected > 0) {
    allWarnings.push({
      code: 'entries_affected',
      segmentIndex: null,
      message: `${entriesAffected} future window${entriesAffected === 1 ? '' : 's'} already hold${entriesAffected === 1 ? 's' : ''} a recorded check. Those keep their original times and are not regenerated.`,
    });
  }

  return {
    date: request.date,
    timeZone: coverage.timeZone,
    windows: previewWindows,
    problems,
    warnings: allWarnings,
    windowsToRegenerate,
    entriesAffected,
  };
}
