import { and, eq, gt, gte, isNull, lte } from 'drizzle-orm';
import { buildNotification, isAssignmentEffective, type NotificationKind } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  checkWindows,
  participantAssignments,
  teamScopes,
  users,
  windowMissReasons,
} from '../db/schema.js';
import { notifiableName, notify, isConfigured, type VapidKeys } from './push.js';

/**
 * Who gets told what, and when (doc 09 Phase 5).
 *
 * Three moments matter: a window is open and nothing is recorded, a window is
 * about to close, and a window closed with nothing in it. The fourth is an
 * escalation, which is the only one that goes to somebody other than the
 * person on shift.
 *
 * Every send is deduplicated by `(user, kind, window)` inside `notify`, so
 * running this every five minutes does not mean notifying every five minutes.
 */

/** How long before a window closes the "closing soon" notification goes out. */
export const CLOSING_SOON_MINUTES = 20;

/** How long a missed window may sit unresolved before a team leader is told. */
export const ESCALATION_AFTER_MINUTES = 60;

export type NotificationRun = {
  due: number;
  closing: number;
  overdue: number;
  escalated: number;
  pruned: number;
};

/** Workers currently assigned to a participant. */
async function assignedUserIds(db: Database, participantId: string, now: Date): Promise<string[]> {
  const rows = await db
    .select({
      userId: participantAssignments.userId,
      kind: participantAssignments.kind,
      revokedAt: participantAssignments.revokedAt,
      expiresAt: participantAssignments.expiresAt,
    })
    .from(participantAssignments)
    .innerJoin(users, eq(users.id, participantAssignments.userId))
    .where(
      and(eq(participantAssignments.participantId, participantId), eq(users.status, 'active')),
    );

  return [
    ...new Set(
      rows
        .filter((row) =>
          isAssignmentEffective(
            {
              participantId,
              kind: row.kind,
              revokedAt: row.revokedAt,
              expiresAt: row.expiresAt,
            },
            now,
          ),
        )
        .map((row) => row.userId),
    ),
  ];
}

/**
 * Who an unresolved miss escalates to: the team leaders and nurses who oversee
 * this participant, plus every admin. Not the worker, who has already been
 * told twice and is evidently not in a position to act.
 */
async function overseerIds(db: Database, participantId: string): Promise<string[]> {
  const admins = await db
    .select({ userId: users.id })
    .from(users)
    .where(and(eq(users.status, 'active'), eq(users.role, 'admin')));

  const overseers = await db
    .select({ userId: teamScopes.userId })
    .from(teamScopes)
    .innerJoin(users, eq(users.id, teamScopes.userId))
    .where(
      and(
        eq(teamScopes.participantId, participantId),
        isNull(teamScopes.revokedAt),
        eq(users.status, 'active'),
      ),
    );

  return [...new Set([...admins, ...overseers].map((row) => row.userId))];
}

async function fanOut(
  db: Database,
  keyRing: KeyRing,
  keys: VapidKeys | null,
  userIds: readonly string[],
  kind: NotificationKind,
  window: { id: string; participantId: string; endsAt: Date },
  now: Date,
): Promise<number> {
  if (userIds.length === 0) return 0;

  const participantName = await notifiableName(db, keyRing, window.participantId);
  const payload = buildNotification(kind, {
    participantName,
    participantId: window.participantId,
    windowId: window.id,
    minutes: Math.max(0, Math.round((window.endsAt.getTime() - now.getTime()) / 60_000)),
  });

  let sent = 0;
  for (const userId of userIds) {
    const result = await notify(db, keys, userId, kind, window.id, payload);
    sent += result.sent;
  }
  return sent;
}

export async function runNotifications(
  db: Database,
  keyRing: KeyRing,
  keys: VapidKeys | null,
  now = new Date(),
): Promise<NotificationRun> {
  const run: NotificationRun = { due: 0, closing: 0, overdue: 0, escalated: 0, pruned: 0 };
  if (!isConfigured(keys)) return run;

  const closingFrom = new Date(now.getTime() + CLOSING_SOON_MINUTES * 60_000);
  const escalateBefore = new Date(now.getTime() - ESCALATION_AFTER_MINUTES * 60_000);

  // Open, expected, nothing recorded. `pending` and not `partial`: a worker
  // part way through a form knows perfectly well the window is open.
  const open = await db
    .select({
      id: checkWindows.id,
      participantId: checkWindows.participantId,
      startsAt: checkWindows.startsAt,
      endsAt: checkWindows.endsAt,
    })
    .from(checkWindows)
    .where(
      and(
        eq(checkWindows.status, 'pending'),
        eq(checkWindows.expected, true),
        lte(checkWindows.startsAt, now),
        gt(checkWindows.endsAt, now),
      ),
    );

  for (const window of open) {
    const recipients = await assignedUserIds(db, window.participantId, now);
    run.due += await fanOut(db, keyRing, keys, recipients, 'check_due', window, now);

    if (window.endsAt <= closingFrom) {
      run.closing += await fanOut(db, keyRing, keys, recipients, 'check_closing', window, now);
    }
  }

  // Closed with nothing recorded. The closer job has already moved these to
  // `missed`, so this is reporting a fact rather than deciding one.
  const missed = await db
    .select({
      id: checkWindows.id,
      participantId: checkWindows.participantId,
      endsAt: checkWindows.endsAt,
      reasonId: windowMissReasons.id,
    })
    .from(checkWindows)
    .leftJoin(windowMissReasons, eq(windowMissReasons.windowId, checkWindows.id))
    .where(
      and(
        eq(checkWindows.status, 'missed'),
        isNull(windowMissReasons.id),
        gte(checkWindows.endsAt, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    );

  for (const window of missed) {
    const recipients = await assignedUserIds(db, window.participantId, now);
    run.overdue += await fanOut(db, keyRing, keys, recipients, 'check_overdue', window, now);

    if (window.endsAt <= escalateBefore) {
      const overseers = await overseerIds(db, window.participantId);
      run.escalated += await fanOut(db, keyRing, keys, overseers, 'escalation', window, now);
    }
  }

  return run;
}

export { pruneNotificationHistory } from './push.js';

/**
 * A published care plan (doc 01 §9).
 *
 * Every worker currently assigned to the participant, and nobody else: this is
 * "read the new instructions", which is only meaningful to somebody who will be
 * standing in the room. Deduplicated by the version id, so republishing the
 * same version twice notifies once and a second version notifies again.
 */
export async function notifyCarePlanPublished(
  db: Database,
  keyRing: KeyRing,
  keys: VapidKeys | null,
  input: { participantId: string; carePlanId: string; versionId: string },
  now = new Date(),
): Promise<number> {
  if (!isConfigured(keys)) return 0;

  const userIds = await assignedUserIds(db, input.participantId, now);
  if (userIds.length === 0) return 0;

  const payload = buildNotification('care_plan_published', {
    participantName: await notifiableName(db, keyRing, input.participantId),
    participantId: input.participantId,
    carePlanId: input.carePlanId,
  });

  let sent = 0;
  for (const userId of userIds) {
    const result = await notify(db, keys, userId, 'care_plan_published', input.versionId, payload);
    sent += result.sent;
  }
  return sent;
}
