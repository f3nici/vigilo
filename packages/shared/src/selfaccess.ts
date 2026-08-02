import { z } from 'zod';
import { dailyEntryValueSchema } from './reports.js';
import type { WindowStatus } from './windows.js';

/**
 * Participant self-access (doc 01 §3.5, doc 06 §6).
 *
 * The person the record is about, reading their own record. Deliberately
 * simple and read-only, and deliberately a different shape from the staff
 * views rather than a filtered copy of them.
 *
 * That distinction is the whole point of this file. A staff DTO with fields
 * removed is one forgotten field away from leaking; a self-access DTO can only
 * ever carry what it declares, and what it declares is what doc 06 §6 lists:
 * visible diary entries, checks that were actually recorded, and the name of
 * whoever wrote each one. No compliance, no missed checks, no incidents, no
 * staff detail beyond a name.
 */

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-01.');

/**
 * Which checks the participant sees.
 *
 * Anything that holds a recorded entry, and nothing else. `missed` and
 * `pending` are about whether staff did what the schedule asked, which doc
 * 06 §6 keeps out of self-access: it concerns staff performance rather than
 * the participant's care, and a person reading their own record should not
 * have to interpret a wall of things that did not happen.
 *
 * `partial` is in, because a partial check is a real record with real content
 * in it. What it is missing is a field, not a fact.
 */
export function participantSeesWindow(status: WindowStatus): boolean {
  return status === 'complete' || status === 'partial';
}

/**
 * How far a self-access browse may reach in one request.
 *
 * A month, matching what the staff reports allow for a single render. Longer
 * ranges are not refused because the data is sensitive (it is the person's own
 * record) but because an unbounded query is how a screen stops loading.
 */
export const SELF_ACCESS_MAX_DAYS = 31;

export const myDayQuerySchema = z
  .object({
    /*
     * Optional, and it means today in the org timezone. The server decides
     * what today is: a phone with a wrong clock should not be able to ask for
     * a different day by accident.
     */
    date: dateSchema.optional(),
  })
  .strict();

export type MyDayQuery = z.infer<typeof myDayQuerySchema>;

export const myRecordsQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'The first date has to be on or before the last one.',
    path: ['to'],
  });

export type MyRecordsQuery = z.infer<typeof myRecordsQuerySchema>;

/* --------------------------------------------------------------- the day */

/**
 * A check, as the person it was about reads it.
 *
 * No window id, no status, no lateness, no edit count. A participant asking
 * "what did they write down on Tuesday" is asking about the readings and who
 * took them, and every field beyond that is a fact about staff work.
 */
export const myCheckSchema = z.object({
  id: z.string(),
  /** When it was recorded, not when the window opened. */
  recordedAt: z.string(),
  templateName: z.string(),
  recordedByName: z.string().nullable(),
  values: z.array(dailyEntryValueSchema),
});

export type MyCheck = z.infer<typeof myCheckSchema>;

/**
 * A photo on one of their own entries, reduced to what it takes to show it.
 *
 * Only the id and whether it is an image. No filename, no size, no upload
 * state: those are facts about the file rather than about the day, and the
 * filename in particular is whatever a worker's phone happened to call it.
 */
export const myPhotoSchema = z.object({
  id: z.string(),
  isImage: z.boolean(),
});

export type MyPhoto = z.infer<typeof myPhotoSchema>;

export const myDiaryEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  categoryLabel: z.string(),
  body: z.string(),
  recordedByName: z.string().nullable(),
  /*
   * Only on entries they can already read, and served by the attachment route
   * that applies the owning entry's read rule on top of scope. A photo of
   * somebody's own afternoon is part of their own record.
   */
  photos: z.array(myPhotoSchema),
  /*
   * Whether it has been changed since it was written, and nothing about who
   * changed it or how many times. Somebody reading their own record is
   * entitled to know a note was edited; the revision history is a staff view.
   */
  edited: z.boolean(),
});

export type MyDiaryEntry = z.infer<typeof myDiaryEntrySchema>;

export const myDaySchema = z.object({
  date: dateSchema,
  checks: z.array(myCheckSchema),
  diary: z.array(myDiaryEntrySchema),
});

export type MyDay = z.infer<typeof myDaySchema>;

export const myRecordsSchema = z.object({
  /** Their own name, so the page and the PDF can say whose record this is. */
  participantName: z.string(),
  orgName: z.string(),
  timeZone: z.string(),
  from: dateSchema,
  to: dateSchema,
  generatedAt: z.string(),
  days: z.array(myDaySchema),
});

export type MyRecords = z.infer<typeof myRecordsSchema>;

/**
 * The day as one list, oldest first.
 *
 * Checks and diary entries interleaved rather than shown as two blocks. A
 * person reading their own day reads it as a day: a check at 09:00, the walk
 * at 10:45, the next check at 13:45. Two lists made the 13:45 check sit above
 * the 10:45 walk, which is only sensible if you already think of a check and a
 * diary entry as different kinds of thing, and the person the record is about
 * has no reason to.
 *
 * Here rather than in the component, so the PDF reads in the same order.
 */
export type MyDayItem =
  | { kind: 'check'; at: string; check: MyCheck }
  | { kind: 'entry'; at: string; entry: MyDiaryEntry };

export function myDayTimeline(day: MyDay): MyDayItem[] {
  const items: MyDayItem[] = [
    ...day.checks.map((check) => ({ kind: 'check' as const, at: check.recordedAt, check })),
    ...day.diary.map((entry) => ({ kind: 'entry' as const, at: entry.occurredAt, entry })),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function dayIsEmpty(day: MyDay): boolean {
  return day.checks.length === 0 && day.diary.length === 0;
}

export function recordCount(day: MyDay): number {
  return day.checks.length + day.diary.length;
}

/**
 * What a day with nothing on it says.
 *
 * Written once here so the screen and the PDF say the same thing. "Nothing was
 * recorded" is a statement about the record, not about the care: staff may
 * have been there all day and written it up under a different date, and a
 * screen that said "nothing happened" would be telling the person something
 * nobody actually knows.
 */
export function emptyDayMessage(date: string, today: string): string {
  if (date === today) return 'Nothing has been written down yet today.';
  if (date > today) return 'This day has not happened yet.';
  return 'Nothing was written down on this day.';
}

/**
 * The plain-language line under a check (doc 06 §6).
 *
 * "Morning check by Sam" rather than a template name and a user id. The time
 * is formatted by the caller, which knows the timezone and the locale.
 */
export function describeMyCheck(check: MyCheck): string {
  return check.recordedByName === null
    ? check.templateName
    : `${check.templateName} by ${check.recordedByName}`;
}
