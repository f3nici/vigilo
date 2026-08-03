import { z } from 'zod';
import { checkWindowSchema, type CheckWindow } from './windows.js';
import { diaryEntrySchema, diarySnippet, type DiaryEntry } from './diary.js';
import { localDateOf } from './timezone.js';

/**
 * The participant timeline (doc 06 §4.2, doc 04 §3).
 *
 * One list, newest first, holding everything that happened to a person on a
 * day: the checks and the diary together. It is the main screen because that is
 * how a shift is actually handed over, and reading two separate lists and
 * interleaving them in your head is exactly the work software should do.
 *
 * The merge lives here rather than in the API so the offline device builds the
 * same timeline from its local tables, in the same order, with no round trip.
 */

export const timelineKinds = ['check', 'diary'] as const;
export const timelineKindSchema = z.enum(timelineKinds);
export type TimelineKind = z.infer<typeof timelineKindSchema>;

export const timelineItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('check'),
    id: z.string(),
    /** What the row sorts and displays on. */
    at: z.string(),
    window: checkWindowSchema,
  }),
  z.object({
    kind: z.literal('diary'),
    id: z.string(),
    at: z.string(),
    entry: diaryEntrySchema,
  }),
]);

export type TimelineItem = z.infer<typeof timelineItemSchema>;

/**
 * When a check appears on the timeline.
 *
 * A recorded check sits at the time it was recorded, because that is the moment
 * something was observed. A window with no entry sits at its start, so a missed
 * 06:00 check appears where 06:00 belongs rather than two hours later where
 * nobody was looking.
 */
export function checkTimelineTime(window: CheckWindow): string {
  return window.completedAt ?? window.startsAt;
}

export function buildTimeline(
  windows: readonly CheckWindow[],
  entries: readonly DiaryEntry[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...windows.map((window): TimelineItem => ({
      kind: 'check',
      id: window.id,
      at: checkTimelineTime(window),
      window,
    })),
    ...entries.map((entry): TimelineItem => ({
      kind: 'diary',
      id: entry.id,
      at: entry.occurredAt,
      entry,
    })),
  ];

  return items.sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at);
    if (byTime !== 0) return byTime;
    // Two things at the same instant still need a stable order, or the list
    // reshuffles under the reader every time it reloads.
    if (a.kind !== b.kind) return a.kind === 'check' ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export type TimelineDay = {
  /** Local ISO date, so a 23:50 entry files under the day it happened here. */
  date: string;
  items: TimelineItem[];
};

/**
 * Days newest first, and each day read forwards.
 *
 * The two directions are deliberate and they answer two different questions.
 * Which day am I looking at is answered by today being at the top, so the
 * screen opens on the shift somebody is handing over. What happened on that day
 * is answered by reading down the page from the morning, which is how a day is
 * told and how the self-access "my day" screen already reads it.
 */
export function groupTimelineByDay(
  items: readonly TimelineItem[],
  timeZone: string,
): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const item of items) {
    const date = localDateOf(new Date(item.at), timeZone);
    const last = days[days.length - 1];
    if (last && last.date === date) last.items.push(item);
    else days.push({ date, items: [item] });
  }

  // The input arrives newest first, which is what puts the days in order. The
  // reverse is what turns each day back into a chronology.
  for (const day of days) day.items.reverse();

  return days;
}

/** The second line of a timeline row, in the words doc 06 §4.2 uses. */
export function describeTimelineItem(item: TimelineItem): string {
  if (item.kind === 'diary') return diarySnippet(item.entry.body);

  const window = item.window;
  if (window.missReason) {
    return window.missReason.note
      ? `Reason: ${window.missReason.label}, "${window.missReason.note}"`
      : `Reason: ${window.missReason.label}`;
  }
  if (window.status === 'not_expected') {
    return window.coverageReason ?? 'Not expected';
  }
  if (window.filledRequiredCount === 0) return 'Nothing recorded yet';

  // Who filled it in, on the row itself. A handover reads better for knowing
  // whether the person who recorded something is still on shift to ask.
  const counted = `${window.filledRequiredCount} of ${window.requiredFieldCount} recorded`;
  return window.recordedByName ? `${counted} by ${window.recordedByName}` : counted;
}

export const timelineSchema = z.object({
  timeZone: z.string(),
  items: z.array(timelineItemSchema),
});

export type Timeline = z.infer<typeof timelineSchema>;
