import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import webpush from 'web-push';
import {
  buildNotification,
  defaultNotificationPreferences,
  notificationPreferencesSchema,
  pushSafeName,
  type NotificationKind,
  type NotificationPreferences,
  type PushPayload,
  type PushSubscriptionRequest,
  type UpdateNotificationPreferences,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  devices,
  notificationPreferences,
  notificationsSent,
  participants,
  pushSubscriptions,
} from '../db/schema.js';
import { decryptField } from '../crypto/fields.js';
import { COLUMN } from './participants.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Web Push (doc 04 §14, doc 07 §7).
 *
 * The one rule that governs everything in this file: nothing sensitive leaves
 * in a payload. A push notification is delivered by a third party, is decrypted
 * on a locked screen and is read by whoever is standing next to the phone. An
 * initial and surname is the ceiling, and every body here is built by
 * `buildNotification` in shared so no caller can decide otherwise.
 */

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

/**
 * Push is off rather than broken when no keys are configured.
 *
 * A self-hosted deployment that has not generated VAPID keys should still run.
 * Every function below no-ops in that state and `isConfigured` is what the app
 * asks before it offers to turn notifications on.
 */
export function isConfigured(keys: VapidKeys | null): keys is VapidKeys {
  return keys !== null;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/* --------------------------------------------------------- subscriptions */

export async function saveSubscription(
  db: Database,
  userId: string,
  request: PushSubscriptionRequest,
): Promise<{ id: string }> {
  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, request.deviceId), eq(devices.userId, userId)))
    .limit(1);
  if (!device) {
    throw new HttpError('not_found', 'That device is not registered.');
  }

  // Keyed on the endpoint, so a browser that re-subscribes with the same
  // endpoint updates one row instead of collecting duplicates that would send
  // the same worker the same notification twice.
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId,
      deviceId: request.deviceId,
      endpoint: request.endpoint,
      p256dh: request.p256dh,
      auth: request.auth,
      expirationTime: request.expirationTime,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        deviceId: request.deviceId,
        p256dh: request.p256dh,
        auth: request.auth,
        expirationTime: request.expirationTime,
        failedAt: null,
        failureCount: 0,
      },
    })
    .returning({ id: pushSubscriptions.id });

  return { id: row!.id };
}

export async function deleteSubscription(
  db: Database,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, subscriptionId), eq(pushSubscriptions.userId, userId)));
}

/* ------------------------------------------------------------ preferences */

/**
 * Merges over the defaults one key at a time.
 *
 * A spread would carry an explicit `undefined` through and switch a kind off
 * that nobody turned off. A kind added in a later release has to default to on
 * for accounts whose stored preferences predate it.
 */
function mergePreferences(
  base: NotificationPreferences,
  overrides: { [K in keyof NotificationPreferences]?: boolean | undefined },
): NotificationPreferences {
  const merged = { ...base };
  for (const kind of Object.keys(base) as (keyof NotificationPreferences)[]) {
    const value = overrides[kind];
    if (typeof value === 'boolean') merged[kind] = value;
  }
  return merged;
}

export async function getPreferences(
  db: Database,
  userId: string,
): Promise<NotificationPreferences> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  if (!row) return defaultNotificationPreferences;

  const parsed = notificationPreferencesSchema.partial().safeParse(row.preferences);
  return mergePreferences(defaultNotificationPreferences, parsed.success ? parsed.data : {});
}

export async function updatePreferences(
  db: Database,
  userId: string,
  request: UpdateNotificationPreferences,
): Promise<NotificationPreferences> {
  const merged = mergePreferences(await getPreferences(db, userId), request);
  await db
    .insert(notificationPreferences)
    .values({ userId, preferences: merged })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { preferences: merged, updatedAt: new Date() },
    });
  return merged;
}

/* -------------------------------------------------------------- delivery */

export type SendResult = {
  sent: number;
  pruned: number;
  skipped: number;
};

/**
 * Sends one notification to one user's devices.
 *
 * Deduplicated by `(user, kind, subject)`: the overdue job runs every five
 * minutes and would otherwise notify about the same window twelve times an
 * hour. A worker who gets the same alert repeatedly turns notifications off,
 * and then misses the ones that matter.
 */
export async function notify(
  db: Database,
  keys: VapidKeys | null,
  userId: string,
  kind: NotificationKind,
  subjectId: string,
  payload: PushPayload,
): Promise<SendResult> {
  const empty: SendResult = { sent: 0, pruned: 0, skipped: 0 };
  if (!isConfigured(keys)) return empty;

  const preferences = await getPreferences(db, userId);
  if (!preferences[kind]) return { ...empty, skipped: 1 };

  const claimed = await db
    .insert(notificationsSent)
    .values({ userId, kind, subjectId })
    .onConflictDoNothing()
    .returning({ id: notificationsSent.id });
  if (claimed.length === 0) return { ...empty, skipped: 1 };

  return send(db, keys, userId, payload);
}

async function send(
  db: Database,
  keys: VapidKeys,
  userId: string,
  payload: PushPayload,
): Promise<SendResult> {
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.failedAt)));

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        body,
        {
          vapidDetails: {
            subject: keys.subject,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
          },
          TTL: 3600,
        },
      );
      sent += 1;
      await db
        .update(pushSubscriptions)
        .set({ lastSentAt: new Date(), failureCount: 0 })
        .where(eq(pushSubscriptions.id, subscription.id));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 0;
      // 404 and 410 mean the endpoint is gone for good. Anything else is
      // transient and the subscription stays, because a push service having a
      // bad five minutes is not a reason to stop notifying somebody forever.
      if (status === 404 || status === 410) {
        dead.push(subscription.id);
      } else {
        await db
          .update(pushSubscriptions)
          .set({ failureCount: subscription.failureCount + 1 })
          .where(eq(pushSubscriptions.id, subscription.id));
      }
    }
  }

  if (dead.length > 0) {
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead));
  }

  return { sent, pruned: dead.length, skipped: 0 };
}

/**
 * How a participant may be named in a notification.
 *
 * Decrypts the name here and reduces it immediately, so the full name exists
 * only as a local in this function and what the caller receives is already
 * safe to send.
 */
export async function notifiableName(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
): Promise<string> {
  const [row] = await db
    .select({ firstNameEnc: participants.firstNameEnc, lastNameEnc: participants.lastNameEnc })
    .from(participants)
    .where(eq(participants.id, participantId))
    .limit(1);
  if (!row) return 'A participant';

  return pushSafeName(
    decryptField(keyRing, COLUMN.firstName, row.firstNameEnc),
    decryptField(keyRing, COLUMN.lastName, row.lastNameEnc),
  );
}

export { buildNotification };

/**
 * Old dedupe rows, cleared so the table does not grow without bound. Anything
 * older than a week can never suppress a fresh notification: no window stays
 * open that long.
 */
export async function pruneNotificationHistory(db: Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const removed = await db
    .delete(notificationsSent)
    .where(lt(notificationsSent.sentAt, cutoff))
    .returning({ id: notificationsSent.id });
  return removed.length;
}
