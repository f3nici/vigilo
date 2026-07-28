import { and, asc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import {
  describeCoverageDecision,
  nextWindowStatus,
  resolveCoverage,
  zonedTimeToUtc,
  type CoverageException,
  type CoverageExceptionRow as SharedExceptionRow,
  type CoveragePattern,
  type CoverageRangeRow,
  type CreateCoverageExceptionRequest,
  type PutCoveragePatternRequest,
  type RecalculationPreview,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  checkEntries,
  checkWindows,
  coverageExceptions,
  coveragePatterns,
  users,
} from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit.js';
import { getOrgSettings } from './org.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Coverage (doc 01 §5.4, doc 03 §5).
 *
 * The rules live in @vigilo/shared; this loads the rows and writes the results.
 *
 * Pattern rows are superseded rather than replaced, keeping `active_from` and
 * `active_to`. Recalculating a past week then uses the pattern that actually
 * applied that week, not today's. An admin who needs to correct history uses a
 * dated exception, which is the tool that says "reality differed here" and
 * records who decided so.
 */

/** Postgres `time` reads back as `HH:MM:SS`; the wire and the rules use `HH:MM`. */
function toTimeOfDay(value: string): string {
  return value.slice(0, 5);
}

function toDbTime(value: string): string {
  return `${value}:00`;
}

/** The org's today, which is the date a pattern change takes effect from. */
async function localToday(db: Database): Promise<string> {
  const org = await getOrgSettings(db);
  return new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(new Date());
}

export type CoverageInputs = {
  ranges: CoverageRangeRow[];
  exceptions: SharedExceptionRow[];
  timeZone: string;
};

/** Everything the coverage rules need for one participant, loaded once. */
export async function loadCoverage(db: Database, participantId: string): Promise<CoverageInputs> {
  const org = await getOrgSettings(db);

  const [patternRows, exceptionRows] = await Promise.all([
    db
      .select()
      .from(coveragePatterns)
      .where(eq(coveragePatterns.participantId, participantId))
      .orderBy(asc(coveragePatterns.weekday), asc(coveragePatterns.startTime)),
    db
      .select()
      .from(coverageExceptions)
      .where(eq(coverageExceptions.participantId, participantId))
      .orderBy(asc(coverageExceptions.createdAt)),
  ]);

  return {
    timeZone: org.timezone,
    ranges: patternRows.map((row) => ({
      weekday: row.weekday,
      startTime: toTimeOfDay(row.startTime),
      endTime: toTimeOfDay(row.endTime),
      activeFrom: row.activeFrom,
      activeTo: row.activeTo,
    })),
    exceptions: exceptionRows.map((row) => ({
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      effect: row.effect,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  };
}

/** The pattern in force today, which is what the weekly grid editor shows. */
export async function getCoveragePattern(
  db: Database,
  participantId: string,
): Promise<CoveragePattern> {
  const today = await localToday(db);

  const rows = await db
    .select()
    .from(coveragePatterns)
    .where(
      and(
        eq(coveragePatterns.participantId, participantId),
        sql`${coveragePatterns.activeFrom} <= ${today}::date`,
        or(isNull(coveragePatterns.activeTo), sql`${coveragePatterns.activeTo} > ${today}::date`),
      ),
    )
    .orderBy(asc(coveragePatterns.weekday), asc(coveragePatterns.startTime));

  return {
    ranges: rows.map((row) => ({
      weekday: row.weekday,
      startTime: toTimeOfDay(row.startTime),
      endTime: toTimeOfDay(row.endTime),
    })),
    updatedAt: rows[0]?.createdAt.toISOString() ?? null,
  };
}

/**
 * Replaces the whole weekly pattern (doc 04 §6). Old rows are closed off at
 * today rather than removed, so last week still knows what last week's
 * supported hours were.
 */
export async function putCoveragePattern(
  db: Database,
  participantId: string,
  request: PutCoveragePatternRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<CoveragePattern> {
  const today = await localToday(db);

  await db.transaction(async (tx) => {
    await tx
      .update(coveragePatterns)
      .set({ activeTo: today })
      .where(
        and(
          eq(coveragePatterns.participantId, participantId),
          or(isNull(coveragePatterns.activeTo), sql`${coveragePatterns.activeTo} > ${today}::date`),
        ),
      );

    if (request.ranges.length > 0) {
      await tx.insert(coveragePatterns).values(
        request.ranges.map((range) => ({
          participantId,
          weekday: range.weekday,
          startTime: toDbTime(range.startTime),
          endTime: toDbTime(range.endTime),
          activeFrom: today,
          createdBy,
        })),
      );
    }
  });

  await recordAudit(db, {
    action: 'coverage.pattern_update',
    actor,
    entityType: 'coverage_pattern',
    entityId: null,
    participantId,
    metadata: { rangeCount: request.ranges.length, effectiveFrom: today },
  });

  return getCoveragePattern(db, participantId);
}

export async function listCoverageExceptions(
  db: Database,
  participantId: string,
): Promise<CoverageException[]> {
  const rows = await db
    .select({
      exception: coverageExceptions,
      createdByName: users.displayName,
    })
    .from(coverageExceptions)
    .leftJoin(users, eq(users.id, coverageExceptions.createdBy))
    .where(eq(coverageExceptions.participantId, participantId))
    .orderBy(asc(coverageExceptions.startsAt));

  return rows.map(({ exception, createdByName }) => ({
    id: exception.id,
    startsAt: exception.startsAt.toISOString(),
    endsAt: exception.endsAt.toISOString(),
    effect: exception.effect,
    reason: exception.reason,
    createdBy: exception.createdBy,
    createdByName,
    createdAt: exception.createdAt.toISOString(),
  }));
}

export async function createCoverageException(
  db: Database,
  participantId: string,
  request: CreateCoverageExceptionRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<CoverageException> {
  const [row] = await db
    .insert(coverageExceptions)
    .values({
      participantId,
      startsAt: new Date(request.startsAt),
      endsAt: new Date(request.endsAt),
      effect: request.effect,
      reason: request.reason,
      createdBy,
    })
    .returning();

  await recordAudit(db, {
    action: 'coverage.exception_create',
    actor,
    entityType: 'coverage_exception',
    entityId: row!.id,
    participantId,
    metadata: { effect: request.effect },
  });

  const [withName] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, createdBy))
    .limit(1);

  return {
    id: row!.id,
    startsAt: row!.startsAt.toISOString(),
    endsAt: row!.endsAt.toISOString(),
    effect: row!.effect,
    reason: row!.reason,
    createdBy: row!.createdBy,
    createdByName: withName?.displayName ?? null,
    createdAt: row!.createdAt.toISOString(),
  };
}

export async function deleteCoverageException(
  db: Database,
  participantId: string,
  exceptionId: string,
  actor: AuditActor,
): Promise<void> {
  const deleted = await db
    .delete(coverageExceptions)
    .where(
      and(
        eq(coverageExceptions.id, exceptionId),
        eq(coverageExceptions.participantId, participantId),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    throw new HttpError('not_found', 'That coverage exception does not exist.');
  }

  await recordAudit(db, {
    action: 'coverage.exception_delete',
    actor,
    entityType: 'coverage_exception',
    entityId: exceptionId,
    participantId,
  });
}

/**
 * Recalculates `expected` over a date range (doc 04 §6).
 *
 * Runs as a preview by default. Changing coverage can turn hundreds of missed
 * windows into not-expected ones and rewrite compliance history, so the count
 * is shown before anything moves, and applying it is audited with the numbers.
 *
 * Windows already holding an entry are never touched. Somebody recorded a check
 * in that window, and re-deciding whether it was expected cannot unmake that.
 */
export async function recalculateCoverage(
  db: Database,
  participantId: string,
  range: { from: string; to: string; apply: boolean },
  actor: AuditActor,
): Promise<RecalculationPreview> {
  const coverage = await loadCoverage(db, participantId);
  const from = zonedTimeToUtc(range.from, 0, coverage.timeZone);
  const to = zonedTimeToUtc(range.to, 24 * 60, coverage.timeZone);

  const rows = await db
    .select({ window: checkWindows, entryId: checkEntries.id })
    .from(checkWindows)
    .leftJoin(checkEntries, eq(checkEntries.windowId, checkWindows.id))
    .where(
      and(
        eq(checkWindows.participantId, participantId),
        gte(checkWindows.startsAt, from),
        lt(checkWindows.startsAt, to),
      ),
    );

  const now = new Date();
  const changes: {
    id: string;
    expected: boolean;
    coverageReason: string | null;
    status: ReturnType<typeof nextWindowStatus>;
  }[] = [];
  let skippedWithEntries = 0;
  let becomingExpected = 0;
  let becomingNotExpected = 0;

  for (const { window, entryId } of rows) {
    const decision = resolveCoverage(
      window,
      coverage.ranges,
      coverage.exceptions,
      coverage.timeZone,
    );
    if (decision.expected === window.expected) continue;

    if (entryId !== null) {
      skippedWithEntries += 1;
      continue;
    }

    if (decision.expected) becomingExpected += 1;
    else becomingNotExpected += 1;

    changes.push({
      id: window.id,
      expected: decision.expected,
      coverageReason: decision.expected ? null : describeCoverageDecision(decision),
      status: nextWindowStatus({
        expected: decision.expected,
        hasEntry: false,
        entryComplete: false,
        endsAt: window.endsAt,
        now,
      }),
    });
  }

  if (range.apply && changes.length > 0) {
    await db.transaction(async (tx) => {
      for (const change of changes) {
        await tx
          .update(checkWindows)
          .set({
            expected: change.expected,
            coverageReason: change.coverageReason,
            status: change.status,
            recalculatedAt: now,
            updatedAt: now,
          })
          .where(eq(checkWindows.id, change.id));
      }
    });
  }

  const preview: RecalculationPreview = {
    applied: range.apply,
    windowsExamined: rows.length,
    becomingExpected,
    becomingNotExpected,
    skippedWithEntries,
  };

  // The preview is read-only, so only the apply is worth an audit row.
  if (range.apply) {
    await recordAudit(db, {
      action: 'coverage.recalculate',
      actor,
      entityType: 'participant',
      entityId: participantId,
      participantId,
      metadata: { ...preview, from: range.from, to: range.to },
    });
  }

  return preview;
}
