import { addDays, weekdayOf } from './timezone.js';

/**
 * The month grid behind the diary (doc 06 §4.2).
 *
 * The diary is the day book: staff write down what a participant has coming
 * up, and the day it lands on is the point of the entry. That makes a month
 * the unit somebody actually thinks in, so the grid is built here rather than
 * in the component, where it would be untestable and would drift from the
 * range the entries are fetched over.
 *
 * Pure calendar arithmetic, no clocks and no offsets. A date is `YYYY-MM-DD`
 * and nothing in this file cares what time it is anywhere.
 */

/** Monday first. Australian rosters and paper diaries both start the week there. */
export const WEEK_STARTS_ON = 1;

export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function addMonths(isoDate: string, months: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

/**
 * Six weeks of dates covering the month `isoDate` falls in, Monday first.
 *
 * Always six rows, even when five would hold the month. A grid that changes
 * height as you page through the year makes the day cells jump under the
 * finger that is tapping them.
 */
export function monthGrid(isoDate: string): string[][] {
  const first = startOfMonth(isoDate);
  const lead = (weekdayOf(first) - WEEK_STARTS_ON + 7) % 7;
  const start = addDays(first, -lead);

  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
  );
}

/**
 * The inclusive date range the grid covers.
 *
 * Entries are fetched over this rather than over the month, so the leading and
 * trailing days borrowed from the neighbouring months show their markers. A
 * grid that draws those cells but never fills them says a day is empty when it
 * is not.
 */
export function monthGridRange(isoDate: string): { from: string; to: string } {
  const weeks = monthGrid(isoDate);
  return { from: weeks[0]![0]!, to: weeks[5]![6]! };
}

export function isSameMonth(isoDate: string, other: string): boolean {
  return isoDate.slice(0, 7) === other.slice(0, 7);
}
