/**
 * Half-open numeric intervals, `[start, end)`.
 *
 * Coverage and schedule segments are both "which parts of a timeline does this
 * cover", asked over different units: minutes of the week for segments, epoch
 * milliseconds for coverage. Writing the set arithmetic once and reusing it
 * means a gap between segments and a gap in supported hours cannot be found by
 * two subtly different rules.
 *
 * Half-open matters. A window ending at 09:00 and one starting at 09:00 do not
 * overlap, and a coverage range ending at 19:00 does not cover 19:00.
 */

export type Interval = { start: number; end: number };

function byStart(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end;
}

/** Sorted, merged, empty intervals dropped. Every function below returns this. */
export function normaliseIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((interval) => interval.end > interval.start).sort(byStart);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      // Touching counts as joined: 09:00-11:00 and 11:00-13:00 are one block.
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

export function unionIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return normaliseIntervals([...a, ...b]);
}

export function subtractIntervals(
  from: readonly Interval[],
  remove: readonly Interval[],
): Interval[] {
  const holes = normaliseIntervals(remove);
  let result = normaliseIntervals(from);

  for (const hole of holes) {
    const next: Interval[] = [];
    for (const interval of result) {
      if (hole.end <= interval.start || hole.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (interval.start < hole.start) next.push({ start: interval.start, end: hole.start });
      if (hole.end < interval.end) next.push({ start: hole.end, end: interval.end });
    }
    result = next;
  }

  return result;
}

export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = normaliseIntervals(a);
  const right = normaliseIntervals(b);
  const result: Interval[] = [];

  for (const one of left) {
    for (const other of right) {
      const start = Math.max(one.start, other.start);
      const end = Math.min(one.end, other.end);
      if (end > start) result.push({ start, end });
    }
  }

  return normaliseIntervals(result);
}

export function clipInterval(interval: Interval, bounds: Interval): Interval | null {
  const start = Math.max(interval.start, bounds.start);
  const end = Math.min(interval.end, bounds.end);
  return end > start ? { start, end } : null;
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function totalLength(intervals: readonly Interval[]): number {
  return normaliseIntervals(intervals).reduce((sum, one) => sum + (one.end - one.start), 0);
}
