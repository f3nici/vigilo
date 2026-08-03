import { z } from 'zod';
import { entryStatusSchema, missReasonSchema } from './checks.js';

/**
 * The window state machine (doc 03 §5).
 *
 * ```
 *                     coverage says not covered
 *    [created] ─────────────────────────────────► not_expected
 *        │                                              │
 *        │ coverage says covered                        │ entry recorded anyway
 *        ▼                                              ▼
 *     pending ──first value saved──► partial ──all required saved──► complete
 *        │                              │
 *        │ ends_at passes               │ ends_at passes
 *        ▼                              ▼
 *      missed ◄───────────────────── missed (partial, unresolved)
 * ```
 *
 * `missed` is not terminal. A late entry can still complete a missed window,
 * and the window keeps `is_late` and its miss reason for the record, because a
 * check that happened an hour late is a different fact from one that never
 * happened and both belong in the history.
 *
 * The device and the server both derive status from this function rather than
 * storing a status one of them invented. If they can disagree, that is a bug.
 */

export const windowStatuses = ['pending', 'partial', 'complete', 'missed', 'not_expected'] as const;

export const windowStatusSchema = z.enum(windowStatuses);
export type WindowStatus = z.infer<typeof windowStatusSchema>;

export type WindowStatusInput = {
  expected: boolean;
  hasEntry: boolean;
  /** Every required field in the bound template version has a value. */
  entryComplete: boolean;
  endsAt: Date;
  now: Date;
};

export function nextWindowStatus(input: WindowStatusInput): WindowStatus {
  // A completed entry is a completed check, whether or not anyone expected it.
  if (input.entryComplete) return 'complete';

  const closed = input.now.getTime() >= input.endsAt.getTime();

  if (!input.expected) {
    // Never `missed`: nobody from the team was there to miss it. A part-filled
    // entry still shows as partial so the work that was done is visible.
    return input.hasEntry ? 'partial' : 'not_expected';
  }

  if (!closed) return input.hasEntry ? 'partial' : 'pending';

  return 'missed';
}

/** Counted in compliance. `not_expected` is excluded from the denominator. */
export function countsTowardCompliance(status: WindowStatus): boolean {
  return status !== 'not_expected';
}

export function needsMissReason(status: WindowStatus, hasMissReason: boolean): boolean {
  return status === 'missed' && !hasMissReason;
}

/**
 * Lateness is measured from the server's clock against `ends_at` (doc 03 §6),
 * not from the device's, so a phone with the wrong time cannot record a check
 * as on time when it was not.
 */
export function lateByMinutes(endsAt: Date, receivedAt: Date): number {
  const late = receivedAt.getTime() - endsAt.getTime();
  return late <= 0 ? 0 : Math.ceil(late / 60_000);
}

export function isLate(endsAt: Date, receivedAt: Date): boolean {
  return receivedAt.getTime() > endsAt.getTime();
}

/**
 * Back-fill past the cut-off needs a team leader (doc 01 §5.5, A6). Default
 * 24 hours, held in org settings. This stops indefinite retrospective record
 * creation without blocking the worker who is an hour behind.
 */
export function backfillNeedsApproval(endsAt: Date, now: Date, cutoffMinutes: number): boolean {
  return lateByMinutes(endsAt, now) > cutoffMinutes;
}

export const checkWindowSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  scheduleId: z.string(),
  scheduleName: z.string(),
  segmentId: z.string().nullable(),
  templateVersionId: z.string(),
  templateName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  expected: z.boolean(),
  /** Why it is not expected, for the greyed-out row (doc 06 §3). */
  coverageReason: z.string().nullable(),
  status: windowStatusSchema,
  completedAt: z.string().nullable(),
  isLate: z.boolean(),
  lateByMinutes: z.number().nullable(),
  /** Filled of required, so the home screen can draw its progress bar. */
  requiredFieldCount: z.number(),
  filledRequiredCount: z.number(),
  entryId: z.string().nullable(),
  /**
   * Who recorded the entry, when there is one.
   *
   * Defaulted rather than required so a window sealed on a device before this
   * field existed still parses. An old cached row says nothing about who
   * recorded it, which is exactly what null means here.
   */
  recordedByName: z.string().nullable().default(null),
  missReason: missReasonSchema.nullable(),
});

export type CheckWindow = z.infer<typeof checkWindowSchema>;

/** The window plus everything needed to render its form offline (doc 04 §7). */
export const windowDetailSchema = checkWindowSchema.extend({
  templateSchema: z.unknown(),
  entryStatus: entryStatusSchema.nullable(),
  entry: z.unknown().nullable(),
  /** True when saving now would need a team leader (doc 01 §5.5). */
  backfillNeedsApproval: z.boolean(),
});

export type WindowDetail = z.infer<typeof windowDetailSchema>;

/**
 * How a window reads on the Today screen. Ordering is deliberate: anything
 * needing a reason sits above anything still open, which sits above the rest
 * (doc 06 §3).
 */
export function windowSortRank(window: {
  status: WindowStatus;
  missReason: unknown | null;
}): number {
  if (needsMissReason(window.status, window.missReason !== null)) return 0;
  if (window.status === 'pending' || window.status === 'partial') return 1;
  if (window.status === 'missed') return 2;
  if (window.status === 'complete') return 3;
  return 4;
}

export function describeWindowStatus(status: WindowStatus): string {
  switch (status) {
    case 'pending':
      return 'Not started';
    case 'partial':
      return 'Part recorded';
    case 'complete':
      return 'Recorded';
    case 'missed':
      return 'Missed';
    case 'not_expected':
      return 'Not expected';
  }
}

/**
 * What is outstanding on each participant, for the list a worker lands on
 * (D90).
 *
 * The worker home is the participant list now, so the list has to answer the
 * question Today used to: which of these people needs me. Without it a missed
 * check is invisible until somebody happens to open the right record, and a
 * missed check that nobody notices is the failure the whole product exists to
 * prevent.
 *
 * Three numbers, in the order they matter. `needsReason` first because it is
 * the one somebody owes an answer to; a window that closed unrecorded is
 * already a fact, and the reason is the part still missing.
 */
export type Outstanding = {
  /** Closed unrecorded, with nobody having said why. */
  needsReason: number;
  /** Open right now and not yet complete. */
  openNow: number;
  /** Missed, already explained. Counted so the row does not look clean. */
  missedExplained: number;
};

export function emptyOutstanding(): Outstanding {
  return { needsReason: 0, openNow: 0, missedExplained: 0 };
}

export function hasOutstanding(one: Outstanding): boolean {
  return one.needsReason > 0 || one.openNow > 0 || one.missedExplained > 0;
}

export function summariseOutstanding(
  windows: readonly CheckWindow[],
  now = new Date(),
): Map<string, Outstanding> {
  const byParticipant = new Map<string, Outstanding>();

  for (const window of windows) {
    const current = byParticipant.get(window.participantId) ?? emptyOutstanding();

    if (needsMissReason(window.status, window.missReason !== null)) {
      current.needsReason += 1;
    } else if (window.status === 'missed') {
      current.missedExplained += 1;
    } else if (
      (window.status === 'pending' || window.status === 'partial') &&
      new Date(window.startsAt) <= now &&
      new Date(window.endsAt) > now
    ) {
      current.openNow += 1;
    }

    byParticipant.set(window.participantId, current);
  }

  return byParticipant;
}

/** The line a participant row shows, or null when there is nothing to say. */
export function describeOutstanding(one: Outstanding): string | null {
  const parts: string[] = [];
  if (one.needsReason > 0) {
    parts.push(
      `${one.needsReason} ${one.needsReason === 1 ? 'check needs' : 'checks need'} a reason`,
    );
  }
  if (one.openNow > 0) parts.push(`${one.openNow} due now`);
  if (one.missedExplained > 0) parts.push(`${one.missedExplained} missed`);
  return parts.length === 0 ? null : parts.join(' · ');
}
