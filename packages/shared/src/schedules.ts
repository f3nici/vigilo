import { z } from 'zod';
import {
  MINUTES_PER_DAY,
  MINUTES_PER_WEEK,
  formatTimeOfDay,
  isTimeOfDay,
  parseTimeOfDay,
  weekdayOf,
  zonedTimeToUtc,
  type MinutesOfDay,
} from './timezone.js';
import {
  intersectIntervals,
  normaliseIntervals,
  subtractIntervals,
  type Interval,
} from './intervals.js';

/**
 * The check grid (doc 01 §5.3, doc 03 §5, doc 06 §5).
 *
 * Windows sit on a fixed grid an admin configures per participant. The grid
 * never rolls forward from the last recorded check, for two reasons that both
 * matter: staff learn a participant's rhythm, and a fixed grid can be generated
 * a week ahead, which is the only reason offline recording is possible at all.
 *
 * This file is the grid. The materialiser on the server and the live preview in
 * the admin UI both call `generateDayWindows`, so what the admin sees before
 * saving is produced by the code that will produce the real windows, not by a
 * second implementation that agrees today and drifts next month.
 */

export const timeOfDaySchema = z.string().trim().refine(isTimeOfDay, 'Use a time like 07:00.');

export const weekdaySchema = z.number().int().min(0).max(6);

export const segmentInputSchema = z
  .object({
    /** Default 120 (doc 01 §5.1). Five minutes is the floor a grid can mean. */
    windowMinutes: z.number().int().min(5).max(MINUTES_PER_DAY).default(120),
    anchorTime: timeOfDaySchema,
    appliesFromTime: timeOfDaySchema,
    appliesToTime: timeOfDaySchema,
    /** Null means every day. An empty list would mean never, so it is refused. */
    weekdays: z.array(weekdaySchema).min(1).max(7).nullable().default(null),
    sortOrder: z.number().int().min(0).max(100).default(0),
    label: z.string().trim().max(60).nullable().default(null),
  })
  .strict();

export type SegmentInput = z.infer<typeof segmentInputSchema>;

export const scheduleStatuses = ['active', 'paused', 'ended'] as const;
export const scheduleStatusSchema = z.enum(scheduleStatuses);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker, or type it as YYYY-MM-DD.');

export const createScheduleRequestSchema = z
  .object({
    templateId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    activeFrom: isoDateSchema,
    activeTo: isoDateSchema.nullable().optional(),
    segments: z.array(segmentInputSchema).min(1).max(12),
  })
  .strict();

export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

export const updateScheduleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    activeFrom: isoDateSchema.optional(),
    activeTo: isoDateSchema.nullable().optional(),
    status: scheduleStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

/** Replaces the whole set atomically, so overlap is checked against the end
 * state rather than against whatever half-applied shape an update passes
 * through (doc 04 §6). */
export const putSegmentsRequestSchema = z
  .object({ segments: z.array(segmentInputSchema).min(1).max(12) })
  .strict();

export type PutSegmentsRequest = z.infer<typeof putSegmentsRequestSchema>;

export const previewScheduleRequestSchema = z
  .object({
    date: isoDateSchema,
    segments: z.array(segmentInputSchema).min(1).max(12),
  })
  .strict();

export type PreviewScheduleRequest = z.infer<typeof previewScheduleRequestSchema>;

/**
 * A segment's local-minute span. `appliesToTime` at or before
 * `appliesFromTime` means it crosses midnight, so the end runs into the next
 * day and the returned `to` is past 1440 (doc 03 §5).
 */
export function segmentSpan(segment: SegmentInput): { from: MinutesOfDay; to: MinutesOfDay } {
  const from = parseTimeOfDay(segment.appliesFromTime);
  const rawTo = parseTimeOfDay(segment.appliesToTime);
  return { from, to: rawTo <= from ? rawTo + MINUTES_PER_DAY : rawTo };
}

export function segmentAppliesOn(segment: SegmentInput, weekday: number): boolean {
  return segment.weekdays === null || segment.weekdays.includes(weekday);
}

export type GridWindow = {
  segmentIndex: number;
  startsAt: Date;
  endsAt: Date;
  /** Local minutes since midnight on the generated date, for the preview. */
  startMinutes: MinutesOfDay;
  endMinutes: MinutesOfDay;
};

/**
 * One segment's windows for one local date.
 *
 * The grid is `anchor + k · windowMinutes` extended in both directions, then
 * clipped to the segment's applicable hours. Clipping rather than skipping is
 * deliberate: an anchor that does not line up with the segment start produces a
 * short first window, which the admin is warned about, instead of a silent gap
 * where nobody is asked to record anything.
 */
export function generateSegmentWindows(
  segment: SegmentInput,
  isoDate: string,
  timeZone: string,
  segmentIndex = 0,
): GridWindow[] {
  if (!segmentAppliesOn(segment, weekdayOf(isoDate))) return [];

  const { from, to } = segmentSpan(segment);
  const anchor = parseTimeOfDay(segment.anchorTime);
  const step = segment.windowMinutes;

  const windows: GridWindow[] = [];
  const firstLine = anchor + Math.floor((from - anchor) / step) * step;

  for (let cursor = firstLine; cursor < to; cursor += step) {
    const startMinutes = Math.max(cursor, from);
    const endMinutes = Math.min(cursor + step, to);
    if (endMinutes <= startMinutes) continue;

    windows.push({
      segmentIndex,
      startMinutes,
      endMinutes,
      startsAt: zonedTimeToUtc(isoDate, startMinutes, timeZone),
      endsAt: zonedTimeToUtc(isoDate, endMinutes, timeZone),
    });
  }

  return windows;
}

/** Every segment's windows for one local date, in clock order. */
export function generateDayWindows(
  segments: readonly SegmentInput[],
  isoDate: string,
  timeZone: string,
): GridWindow[] {
  return segments
    .flatMap((segment, index) => generateSegmentWindows(segment, isoDate, timeZone, index))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * A segment as intervals on a Monday-to-Sunday minute timeline, wrapping past
 * the end of the week back to the start. Overlap and gap detection both work on
 * this, so "these two segments clash" and "nothing covers Sunday night" are
 * answered by the same arithmetic.
 */
export function segmentWeekIntervals(segment: SegmentInput): Interval[] {
  const { from, to } = segmentSpan(segment);
  const days = segment.weekdays ?? [0, 1, 2, 3, 4, 5, 6];

  const intervals: Interval[] = [];
  for (const weekday of days) {
    const start = weekday * MINUTES_PER_DAY + from;
    const end = weekday * MINUTES_PER_DAY + to;
    if (end <= MINUTES_PER_WEEK) {
      intervals.push({ start, end });
    } else {
      intervals.push({ start, end: MINUTES_PER_WEEK });
      intervals.push({ start: 0, end: end - MINUTES_PER_WEEK });
    }
  }

  return normaliseIntervals(intervals);
}

export type SegmentProblem = { code: 'overlap'; message: string; segments: [number, number] };

export type SegmentWarning = {
  code: 'gap' | 'uneven_division' | 'anchor_misaligned' | 'anchor_after_start';
  message: string;
  segmentIndex: number | null;
};

export type SegmentValidation = {
  problems: SegmentProblem[];
  warnings: SegmentWarning[];
};

function segmentName(segment: SegmentInput): string {
  return segment.label ?? `${segment.appliesFromTime} to ${segment.appliesToTime}`;
}

/**
 * Overlaps are a hard error and cannot be saved. Everything else is a warning,
 * because a gap may be exactly what the admin means when coverage accounts for
 * it (doc 06 §5).
 */
export function validateSegments(segments: readonly SegmentInput[]): SegmentValidation {
  const problems: SegmentProblem[] = [];
  const warnings: SegmentWarning[] = [];

  const weekIntervals = segments.map(segmentWeekIntervals);

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const clash = intersectIntervals(weekIntervals[i]!, weekIntervals[j]!);
      if (clash.length > 0) {
        problems.push({
          code: 'overlap',
          segments: [i, j],
          message: `"${segmentName(segments[i]!)}" and "${segmentName(segments[j]!)}" cover some of the same time. Two grids over one hour would ask for the same check twice.`,
        });
      }
    }
  }

  segments.forEach((segment, index) => {
    const { from, to } = segmentSpan(segment);
    const anchor = parseTimeOfDay(segment.anchorTime);
    const span = to - from;

    if (span % segment.windowMinutes !== 0) {
      const tail = span % segment.windowMinutes;
      warnings.push({
        code: 'uneven_division',
        segmentIndex: index,
        message: `${segment.appliesFromTime} to ${segment.appliesToTime} on a ${segment.windowMinutes} minute window leaves a final window of ${tail} minutes.`,
      });
    }

    if (anchor > from) {
      warnings.push({
        code: 'anchor_after_start',
        segmentIndex: index,
        message: `The grid starts at ${segment.anchorTime}, which is after ${segment.appliesFromTime}. The times will still line up, but they are easier to read when the anchor is at or before the start.`,
      });
    } else if ((from - anchor) % segment.windowMinutes !== 0) {
      warnings.push({
        code: 'anchor_misaligned',
        segmentIndex: index,
        message: `A grid anchored at ${segment.anchorTime} does not land on ${segment.appliesFromTime}, so the first window is shorter than the rest.`,
      });
    }
  });

  const uncovered = subtractIntervals([{ start: 0, end: MINUTES_PER_WEEK }], weekIntervals.flat());
  if (uncovered.length > 0 && problems.length === 0) {
    const hours =
      Math.round((uncovered.reduce((sum, one) => sum + (one.end - one.start), 0) / 60) * 10) / 10;
    warnings.push({
      code: 'gap',
      segmentIndex: null,
      message: `${hours} hours a week are not covered by any segment, so no checks are asked for then. That is fine if coverage accounts for it.`,
    });
  }

  return { problems, warnings };
}

/** The wire shapes (doc 04 §6). */
export const scheduleSegmentSchema = z.object({
  id: z.string(),
  windowMinutes: z.number(),
  anchorTime: z.string(),
  appliesFromTime: z.string(),
  appliesToTime: z.string(),
  weekdays: z.array(z.number()).nullable(),
  sortOrder: z.number(),
  label: z.string().nullable(),
});

export type ScheduleSegment = z.infer<typeof scheduleSegmentSchema>;

export const checkScheduleSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  /** Null when the template has never been published, which blocks the grid. */
  publishedVersionId: z.string().nullable(),
  name: z.string(),
  activeFrom: z.string(),
  activeTo: z.string().nullable(),
  status: scheduleStatusSchema,
  segments: z.array(scheduleSegmentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CheckSchedule = z.infer<typeof checkScheduleSchema>;

export const previewWindowSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  startMinutes: z.number(),
  endMinutes: z.number(),
  segmentIndex: z.number(),
  expected: z.boolean(),
  coverageReason: z.string().nullable(),
});

export type PreviewWindow = z.infer<typeof previewWindowSchema>;

export const schedulePreviewSchema = z.object({
  date: z.string(),
  timeZone: z.string(),
  windows: z.array(previewWindowSchema),
  problems: z.array(
    z.object({
      code: z.literal('overlap'),
      message: z.string(),
      segments: z.tuple([z.number(), z.number()]),
    }),
  ),
  warnings: z.array(
    z.object({
      code: z.enum([
        'gap',
        'uneven_division',
        'anchor_misaligned',
        'anchor_after_start',
        'entries_affected',
      ]),
      message: z.string(),
      segmentIndex: z.number().nullable(),
    }),
  ),
  /** Future windows that would be regenerated if this were saved. */
  windowsToRegenerate: z.number(),
  /** Windows already holding an entry, which are never destroyed. */
  entriesAffected: z.number(),
});

export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;

/** A segment in the words the schedule editor uses (doc 06 §5). */
export function describeSegment(segment: SegmentInput): string {
  const everyHours = segment.windowMinutes / 60;
  const every =
    segment.windowMinutes % 60 === 0
      ? `Every ${everyHours} hour${everyHours === 1 ? '' : 's'}`
      : `Every ${segment.windowMinutes} minutes`;
  return `${every}, starting ${segment.anchorTime}`;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeWeekdays(weekdays: readonly number[] | null): string {
  if (weekdays === null || weekdays.length === 7) return 'Every day';
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join() === '0,6') return 'Weekends';
  return sorted.map((day) => WEEKDAY_NAMES[day]).join(', ');
}

export function formatWindowRange(window: { startMinutes: number; endMinutes: number }): string {
  return `${formatTimeOfDay(window.startMinutes)}–${formatTimeOfDay(window.endMinutes)}`;
}
