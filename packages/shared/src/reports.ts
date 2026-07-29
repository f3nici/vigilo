import { z } from 'zod';
import { countsTowardCompliance, windowStatusSchema, type WindowStatus } from './windows.js';

/**
 * Reporting (doc 01 §8, doc 04 §11).
 *
 * The counting lives here rather than in a SQL query because the compliance
 * number is the one figure in this product somebody will be asked to defend.
 * The API and the screens derive it from the same function on the same inputs,
 * so a percentage on a PDF handed to an auditor and a percentage on an admin's
 * screen cannot disagree.
 *
 * Nothing here judges a recorded value. A compliance percentage is about
 * whether the team did what the schedule asked, never about what was observed
 * (CLAUDE.md).
 */

/* ---------------------------------------------------------- compliance */

/**
 * One window, reduced to what compliance cares about.
 *
 * Deliberately not the whole `CheckWindow`: the count must not depend on
 * anything that is not in these four fields, and a caller who has to supply a
 * template name to get a percentage would be a caller who could get it wrong.
 */
export type ComplianceWindow = {
  status: WindowStatus;
  isLate: boolean;
  hasMissReason: boolean;
  /** For the by-worker breakdown. Null when nobody recorded anything. */
  recordedBy?: string | null;
};

export const complianceCountsSchema = z.object({
  /** The denominator. `not_expected` windows are not in it. */
  expected: z.number(),
  completed: z.number(),
  /** A subset of `completed`, not a separate column in the total. */
  completedLate: z.number(),
  partial: z.number(),
  /** Still open. Counted as expected, not yet anything else. */
  pending: z.number(),
  missed: z.number(),
  missedWithReason: z.number(),
  missedWithoutReason: z.number(),
  /** Shown separately, never folded into the percentage (doc 01 §5.6). */
  notExpected: z.number(),
});

export type ComplianceCounts = z.infer<typeof complianceCountsSchema>;

export function emptyCounts(): ComplianceCounts {
  return {
    expected: 0,
    completed: 0,
    completedLate: 0,
    partial: 0,
    pending: 0,
    missed: 0,
    missedWithReason: 0,
    missedWithoutReason: 0,
    notExpected: 0,
  };
}

export function countCompliance(windows: readonly ComplianceWindow[]): ComplianceCounts {
  const counts = emptyCounts();

  for (const window of windows) {
    if (!countsTowardCompliance(window.status)) {
      counts.notExpected += 1;
      continue;
    }

    counts.expected += 1;

    switch (window.status) {
      case 'complete':
        counts.completed += 1;
        if (window.isLate) counts.completedLate += 1;
        break;
      case 'partial':
        counts.partial += 1;
        break;
      case 'pending':
        counts.pending += 1;
        break;
      case 'missed':
        counts.missed += 1;
        if (window.hasMissReason) counts.missedWithReason += 1;
        else counts.missedWithoutReason += 1;
        break;
      case 'not_expected':
        break;
    }
  }

  return counts;
}

/**
 * Completed over expected, as a whole number of percent.
 *
 * Null rather than 100 or 0 when nothing was expected. A week with no
 * scheduled checks has no compliance figure, and printing "100%" for it would
 * be a claim nobody made.
 *
 * A partial entry does not count as completed. Somebody looking at this number
 * is asking whether the check was done, and half a set of observations is not
 * a check that was done.
 */
export function completionPercent(counts: ComplianceCounts): number | null {
  if (counts.expected === 0) return null;
  return Math.round((counts.completed / counts.expected) * 100);
}

/** Missed windows nobody has explained. The number an auditor asks about. */
export function unexplainedPercent(counts: ComplianceCounts): number | null {
  if (counts.expected === 0) return null;
  return Math.round((counts.missedWithoutReason / counts.expected) * 100);
}

export const complianceRowSchema = z.object({
  /** A participant id, a user id, or a date, depending on the grouping. */
  key: z.string(),
  label: z.string(),
  counts: complianceCountsSchema,
  completionPercent: z.number().nullable(),
});

export type ComplianceRow = z.infer<typeof complianceRowSchema>;

export const complianceGroupings = ['participant', 'worker', 'day'] as const;
export const complianceGroupingSchema = z.enum(complianceGroupings);
export type ComplianceGrouping = z.infer<typeof complianceGroupingSchema>;

export const complianceReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  timeZone: z.string(),
  groupBy: complianceGroupingSchema,
  rows: z.array(complianceRowSchema),
  total: complianceCountsSchema,
  totalPercent: z.number().nullable(),
});

export type ComplianceReport = z.infer<typeof complianceReportSchema>;

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-07-29.');

export const complianceQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    participantId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    groupBy: complianceGroupingSchema.default('participant'),
  })
  .refine((value) => value.from <= value.to, 'The start date must not be after the end date.');

export type ComplianceQuery = z.infer<typeof complianceQuerySchema>;

/* -------------------------------------------------------------- trends */

export const trendBuckets = ['none', 'day', 'week'] as const;
export const trendBucketSchema = z.enum(trendBuckets);
export type TrendBucket = z.infer<typeof trendBucketSchema>;

export const trendPointSchema = z.object({
  at: z.string(),
  value: z.number(),
  /** How many readings this point averages. 1 when the bucket is `none`. */
  samples: z.number(),
});

export type TrendPoint = z.infer<typeof trendPointSchema>;

export const trendGapSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Whole hours, so a chart can size the break honestly. */
  hours: z.number(),
});

export type TrendGap = z.infer<typeof trendGapSchema>;

export const trendSeriesSchema = z.object({
  participantId: z.string(),
  fieldKey: z.string(),
  label: z.string(),
  unit: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  timeZone: z.string(),
  bucket: trendBucketSchema,
  points: z.array(trendPointSchema),
  /**
   * Where there is no data, stated rather than implied. A line drawn across a
   * two-day hole reads as two days of steady readings, which is a claim the
   * record does not support (doc 01 §8).
   */
  gaps: z.array(trendGapSchema),
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
});

export type TrendSeries = z.infer<typeof trendSeriesSchema>;

export const trendQuerySchema = z
  .object({
    participantId: z.string().uuid(),
    fieldKey: z.string().min(1).max(60),
    from: dateSchema,
    to: dateSchema,
    bucket: trendBucketSchema.default('none'),
  })
  .refine((value) => value.from <= value.to, 'The start date must not be after the end date.');

export type TrendQuery = z.infer<typeof trendQuerySchema>;

/**
 * A gap is any stretch longer than this with no reading.
 *
 * Six hours rather than a multiple of the window length, because a trend can
 * cross a schedule change and the window length is not a property of the
 * series. It is deliberately generous: an overnight 4-hourly gap is normal and
 * should not be drawn as a hole.
 */
export const TREND_GAP_HOURS = 6;

/**
 * Finds the stretches with no readings.
 *
 * Reported alongside the points rather than filled in. Every chart in this
 * product has to be able to say "nothing was recorded here", because the
 * honest answer to a missing observation is that it is missing.
 */
export function findGaps(
  points: readonly { at: string }[],
  gapHours = TREND_GAP_HOURS,
): TrendGap[] {
  const gaps: TrendGap[] = [];
  const threshold = gapHours * 60 * 60 * 1000;

  for (let index = 1; index < points.length; index += 1) {
    const previous = Date.parse(points[index - 1]!.at);
    const current = Date.parse(points[index]!.at);
    const span = current - previous;
    if (span <= threshold) continue;

    gaps.push({
      from: points[index - 1]!.at,
      to: points[index]!.at,
      hours: Math.round(span / (60 * 60 * 1000)),
    });
  }

  return gaps;
}

export function summarise(points: readonly TrendPoint[]): {
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  if (points.length === 0) return { min: null, max: null, mean: null };

  const values = points.map((point) => point.value);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    // Two decimals: a mean of readings is not more precise than the readings.
    mean: Math.round((total / values.length) * 100) / 100,
  };
}

/* ---------------------------------------------------------- daily report */

export const dailyEntryValueSchema = z.object({
  fieldKey: z.string(),
  label: z.string(),
  /** Already rendered for a human, units and choice labels included. */
  display: z.string(),
});

export type DailyEntryValue = z.infer<typeof dailyEntryValueSchema>;

export const dailyWindowSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: windowStatusSchema,
  expected: z.boolean(),
  coverageReason: z.string().nullable(),
  isLate: z.boolean(),
  lateByMinutes: z.number().nullable(),
  recordedByName: z.string().nullable(),
  recordedAt: z.string().nullable(),
  editCount: z.number(),
  values: z.array(dailyEntryValueSchema),
  missReason: z.object({ label: z.string(), note: z.string().nullable() }).nullable(),
});

export type DailyWindow = z.infer<typeof dailyWindowSchema>;

export const dailyDiaryEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  categoryLabel: z.string(),
  body: z.string(),
  recordedByName: z.string().nullable(),
  editCount: z.number(),
  attachmentCount: z.number(),
});

export type DailyDiaryEntry = z.infer<typeof dailyDiaryEntrySchema>;

export const dailyDaySchema = z.object({
  date: z.string(),
  windows: z.array(dailyWindowSchema),
  diary: z.array(dailyDiaryEntrySchema),
  counts: complianceCountsSchema,
});

export type DailyDay = z.infer<typeof dailyDaySchema>;

export const dailyReportSchema = z.object({
  participant: z.object({
    id: z.string(),
    name: z.string(),
    dateOfBirth: z.string(),
    ndisNumber: z.string(),
  }),
  alerts: z.array(z.object({ kind: z.string(), severity: z.string(), text: z.string() })),
  from: z.string(),
  to: z.string(),
  timeZone: z.string(),
  orgName: z.string(),
  generatedAt: z.string(),
  generatedByName: z.string(),
  days: z.array(dailyDaySchema),
  total: complianceCountsSchema,
});

export type DailyReport = z.infer<typeof dailyReportSchema>;

/** A single day and a range are the same report, so one query covers both. */
export const dailyQuerySchema = z
  .object({
    participantId: z.string().uuid(),
    date: dateSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .transform((value) => ({
    participantId: value.participantId,
    from: value.from ?? value.date ?? '',
    to: value.to ?? value.date ?? value.from ?? '',
  }))
  .refine((value) => value.from !== '', 'Give a date, or a from and to.')
  .refine((value) => value.from <= value.to, 'The start date must not be after the end date.');

export type DailyQuery = z.infer<typeof dailyQuerySchema>;

/**
 * How long a report may span.
 *
 * A month must render in under ten seconds (doc 01 §11), and a request for a
 * decade is a request nobody makes on purpose. Refusing it is kinder than
 * timing out.
 */
export const REPORT_MAX_DAYS = 366;

export function rangeTooLong(from: string, to: string, maxDays = REPORT_MAX_DAYS): boolean {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return days > maxDays;
}

/* --------------------------------------------------------------- exports */

export const exportKinds = ['checks', 'diary'] as const;
export const exportKindSchema = z.enum(exportKinds);
export type ExportKind = z.infer<typeof exportKindSchema>;

export const exportQuerySchema = z
  .object({
    kind: exportKindSchema,
    from: dateSchema,
    to: dateSchema,
    participantId: z.string().uuid().optional(),
  })
  .refine((value) => value.from <= value.to, 'The start date must not be after the end date.');

export type ExportQuery = z.infer<typeof exportQuerySchema>;

/**
 * Above this many rows the export becomes a job.
 *
 * A request that streams for two minutes is a request a proxy will cut, and a
 * download that dies at 80 percent looks like a smaller export than it was.
 * Below the threshold the file comes straight back, which is the common case.
 */
export const EXPORT_INLINE_ROW_LIMIT = 5_000;

export const exportJobStatuses = ['queued', 'running', 'ready', 'failed'] as const;
export const exportJobStatusSchema = z.enum(exportJobStatuses);
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

export const exportJobSchema = z.object({
  id: z.string(),
  kind: exportKindSchema,
  from: z.string(),
  to: z.string(),
  status: exportJobStatusSchema,
  rowCount: z.number().nullable(),
  byteSize: z.number().nullable(),
  error: z.string().nullable(),
  requestedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type ExportJob = z.infer<typeof exportJobSchema>;

/**
 * One CSV field.
 *
 * Quoted whenever it contains a comma, a quote, a newline or leading
 * whitespace, with quotes doubled. And a field starting with `=`, `+`, `-` or
 * `@` is prefixed with a quote, because a spreadsheet treats those as formulas:
 * a diary note beginning "=" would otherwise execute when an auditor opens the
 * file. That is a real attack, and this export is handed to outsiders.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvRow(values: readonly (string | number | boolean | null | undefined)[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}
