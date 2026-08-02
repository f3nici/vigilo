import { z } from 'zod';
import {
  MINUTES_PER_DAY,
  addDays,
  localDateOf,
  parseTimeOfDay,
  weekdayOf,
  zonedTimeToUtc,
} from './timezone.js';
import {
  intersectIntervals,
  normaliseIntervals,
  subtractIntervals,
  unionIntervals,
  type Interval,
} from './intervals.js';
import { timeOfDaySchema, weekdaySchema } from './schedules.js';

/**
 * When a check is expected (doc 01 §5.4).
 *
 * Families provide a lot of support, and those hours must not be counted as
 * missed checks. Two mechanisms: a weekly pattern of supported hours, and dated
 * exceptions for reality. Exceptions win, and later exceptions win over earlier
 * ones.
 *
 * **No pattern at all means always covered.** A participant whose coverage has
 * not been set up yet gets expected windows, and an admin narrows from there.
 * The other reading, that an unconfigured pattern covers nothing, would let a
 * schedule be built and produce a week of `not_expected` windows without saying
 * why, and nobody would notice until the compliance report was empty.
 */

export const coverageEffects = ['covered', 'not_covered'] as const;
export const coverageEffectSchema = z.enum(coverageEffects);
export type CoverageEffect = z.infer<typeof coverageEffectSchema>;

/**
 * The end of a day, as minutes.
 *
 * A range ending at midnight can be written `24:00` or `00:00`, and both mean
 * the same instant. Both spellings exist because `<input type="time">` refuses
 * `24:00` outright, so the picker an admin actually uses can only produce
 * `00:00`, while doc 03 §5 writes end-of-day as `24:00`.
 */
export function endOfDayMinutes(endTime: string): number {
  const minutes = parseTimeOfDay(endTime);
  return minutes === 0 ? MINUTES_PER_DAY : minutes;
}

export const coverageRangeSchema = z
  .object({
    weekday: weekdaySchema,
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
  })
  .strict()
  .refine(
    (range) => endOfDayMinutes(range.endTime) > parseTimeOfDay(range.startTime),
    'A range ends after it starts. Split a range that runs past midnight into two, one ending at midnight and one starting 00:00 the next day.',
  );

export type CoverageRangeInput = z.infer<typeof coverageRangeSchema>;

/**
 * Round-the-clock support, written down (D86).
 *
 * An empty pattern already means "always covered", but nothing on screen said
 * so, and an absence is a poor way to state a fact somebody will later be asked
 * to defend. This is the same thing spelled out: seven days, midnight to
 * midnight. The screen shows it, the audit log records it, and a coverage
 * recalculation reads a real pattern rather than inferring from a gap.
 *
 * `00:00` at both ends because `<input type="time">` refuses `24:00`, and
 * `endOfDayMinutes` already reads a closing `00:00` as the end of the day.
 */
export const ROUND_THE_CLOCK: CoverageRangeInput[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startTime: '00:00',
  endTime: '00:00',
}));

/** Whether a pattern covers every minute of the week. */
export function isRoundTheClock(ranges: readonly CoverageRangeInput[]): boolean {
  if (ranges.length === 0) return false;

  const covered = new Set<number>();
  for (const range of ranges) {
    if (
      parseTimeOfDay(range.startTime) === 0 &&
      endOfDayMinutes(range.endTime) === MINUTES_PER_DAY
    ) {
      covered.add(range.weekday);
    }
  }
  return covered.size === 7;
}

export const putCoveragePatternRequestSchema = z
  .object({ ranges: z.array(coverageRangeSchema).max(70) })
  .strict();

export type PutCoveragePatternRequest = z.infer<typeof putCoveragePatternRequestSchema>;

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const createCoverageExceptionRequestSchema = z
  .object({
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    effect: coverageEffectSchema,
    reason: z.string().trim().min(1).max(300),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.endsAt) > Date.parse(value.startsAt),
    'It ends before it starts.',
  );

export type CreateCoverageExceptionRequest = z.infer<typeof createCoverageExceptionRequestSchema>;

export const coverageExceptionSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  effect: coverageEffectSchema,
  reason: z.string(),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});

export type CoverageException = z.infer<typeof coverageExceptionSchema>;

export const coveragePatternSchema = z.object({
  ranges: z.array(
    z.object({
      weekday: weekdaySchema,
      startTime: z.string(),
      endTime: z.string(),
    }),
  ),
  updatedAt: z.string().nullable(),
});

export type CoveragePattern = z.infer<typeof coveragePatternSchema>;

/** A pattern row as it is held, with the dates it applied between. */
export type CoverageRangeRow = {
  weekday: number;
  startTime: string;
  endTime: string;
  activeFrom: string;
  activeTo: string | null;
};

/** An exception as it is held. `createdAt` is what breaks ties between them. */
export type CoverageExceptionRow = {
  startsAt: Date;
  endsAt: Date;
  effect: CoverageEffect;
  reason: string;
  createdAt: Date;
};

function rangeAppliesOn(range: CoverageRangeRow, isoDate: string): boolean {
  if (range.activeFrom > isoDate) return false;
  return range.activeTo === null || range.activeTo > isoDate;
}

/**
 * Supported hours as instants, over the span a window touches.
 *
 * The local dates either side are included because a range on Monday can reach
 * into Tuesday in UTC, and a window starting late on Sunday is partly Monday's
 * problem.
 */
export function patternIntervals(
  ranges: readonly CoverageRangeRow[],
  bounds: Interval,
  timeZone: string,
): Interval[] {
  const firstDate = addDays(localDateOf(new Date(bounds.start), timeZone), -1);
  const lastDate = addDays(localDateOf(new Date(bounds.end), timeZone), 1);

  const intervals: Interval[] = [];
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const range of ranges) {
      if (range.weekday !== weekday) continue;
      if (!rangeAppliesOn(range, date)) continue;
      intervals.push({
        start: zonedTimeToUtc(date, parseTimeOfDay(range.startTime), timeZone).getTime(),
        end: zonedTimeToUtc(date, endOfDayMinutes(range.endTime), timeZone).getTime(),
      });
    }
  }

  return normaliseIntervals(intervals);
}

export type CoverageDecision = {
  expected: boolean;
  /** Why, in the words the greyed-out window on screen will use. */
  reason: 'covered' | 'outside_supported_hours' | 'exception';
  exceptionReason: string | null;
};

/**
 * Whether a window is expected.
 *
 * **Expected if any part of it is covered** (doc 10 Q5, taking the suggested
 * default). A 2-hour window from 18:00 where support ends at 19:00 still has an
 * hour of someone there to record it, and calling that not-expected would hide
 * a check that could and should have happened.
 */
export function resolveCoverage(
  window: { startsAt: Date; endsAt: Date },
  ranges: readonly CoverageRangeRow[],
  exceptions: readonly CoverageExceptionRow[],
  timeZone: string,
): CoverageDecision {
  const bounds: Interval = { start: window.startsAt.getTime(), end: window.endsAt.getTime() };

  // No pattern configured means the whole span counts as supported.
  const base =
    ranges.length === 0
      ? [bounds]
      : intersectIntervals(patternIntervals(ranges, bounds, timeZone), [bounds]);

  const overlapping = exceptions
    .filter((one) => one.startsAt.getTime() < bounds.end && one.endsAt.getTime() > bounds.start)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let covered = base;
  for (const exception of overlapping) {
    const span: Interval = { start: exception.startsAt.getTime(), end: exception.endsAt.getTime() };
    covered =
      exception.effect === 'covered'
        ? intersectIntervals(unionIntervals(covered, [span]), [bounds])
        : subtractIntervals(covered, [span]);
  }

  if (covered.length > 0) {
    return { expected: true, reason: 'covered', exceptionReason: null };
  }

  const blocking = [...overlapping].reverse().find((one) => one.effect === 'not_covered');
  if (blocking) {
    return { expected: false, reason: 'exception', exceptionReason: blocking.reason };
  }

  return { expected: false, reason: 'outside_supported_hours', exceptionReason: null };
}

export function describeCoverageDecision(decision: CoverageDecision): string {
  if (decision.expected) return 'Supported hours';
  if (decision.reason === 'exception') return decision.exceptionReason ?? 'Coverage exception';
  return 'Outside supported hours';
}

/**
 * What a recalculation would change, before it changes it (doc 04 §6).
 *
 * Coverage edits can turn hundreds of missed windows into not-expected ones and
 * rewrite compliance history, so the count is shown first and the apply is
 * audited.
 */
export const recalculateCoverageRequestSchema = z
  .object({
    from: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
    apply: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.to >= value.from, 'The end date is before the start date.');

export type RecalculateCoverageRequest = z.infer<typeof recalculateCoverageRequestSchema>;

export const recalculationPreviewSchema = z.object({
  applied: z.boolean(),
  windowsExamined: z.number(),
  becomingExpected: z.number(),
  becomingNotExpected: z.number(),
  /** Windows holding an entry are never touched, and this says how many. */
  skippedWithEntries: z.number(),
});

export type RecalculationPreview = z.infer<typeof recalculationPreviewSchema>;
