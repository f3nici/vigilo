import { z } from 'zod';

/**
 * Web Push (doc 04 §14). FCM and APNs replace the transport in the native
 * phases and these shapes do not change, which is the point of putting them
 * here rather than in the web adapter.
 */

export const notificationKinds = [
  /** A window is open and nothing has been recorded yet. */
  'check_due',
  /** The window closes soon. */
  'check_closing',
  /** The window closed with nothing recorded. */
  'check_overdue',
  /** An overdue window nobody has resolved, sent to the team leader. */
  'escalation',
  /** Records have been sitting unsent on this device for a day. */
  'sync_stale',
  /** A new version of a care plan was published for an assigned participant. */
  'care_plan_published',
] as const;

export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationPreferencesSchema = z.object({
  check_due: z.boolean(),
  check_closing: z.boolean(),
  check_overdue: z.boolean(),
  escalation: z.boolean(),
  sync_stale: z.boolean(),
  care_plan_published: z.boolean(),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/**
 * Everything on by default. A worker who has not thought about notifications
 * is exactly the worker who needs the overdue one.
 */
export const defaultNotificationPreferences: NotificationPreferences = {
  check_due: true,
  check_closing: true,
  check_overdue: true,
  escalation: true,
  sync_stale: true,
  care_plan_published: true,
};

export const updateNotificationPreferencesSchema = notificationPreferencesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>;

/**
 * A browser push subscription, as `PushSubscription.toJSON()` produces it.
 * The endpoint is the address the push service routes on and the keys are
 * what the payload is encrypted to, so all three are required.
 */
export const pushSubscriptionRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    endpoint: z.string().url().max(2000),
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
    /** Set by the push service. Used to renew before it lapses. */
    expirationTime: z.number().nullable().default(null),
  })
  .strict();

export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

export const pushSubscriptionSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  endpoint: z.string(),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  failedAt: z.string().nullable(),
});

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/**
 * What actually crosses the wire to the push service.
 *
 * Nothing sensitive, ever (CLAUDE.md). No diary text, no readings, no reason
 * codes. An initial and surname is the ceiling, and the deep link is how the
 * worker gets the detail, behind their own unlock.
 */
export const pushPayloadSchema = z.object({
  kind: notificationKindSchema,
  title: z.string().max(80),
  body: z.string().max(160),
  /** In-app path, never an absolute URL. */
  url: z.string().startsWith('/').max(200),
  /** Collapses repeats of the same subject on the device. */
  tag: z.string().max(80),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * How a participant may be named in a notification: first initial and surname.
 *
 * This is the single place that rule is implemented, so no caller can decide
 * a full name is fine "just this once".
 */
export function pushSafeName(firstName: string, lastName: string): string {
  const initial = firstName.trim().charAt(0).toUpperCase();
  const surname = lastName.trim();
  if (initial === '') return surname === '' ? 'A participant' : surname;
  if (surname === '') return `${initial}.`;
  return `${initial}. ${surname}`;
}

export function buildNotification(
  kind: NotificationKind,
  input: {
    participantName: string;
    participantId: string;
    windowId?: string;
    minutes?: number;
    carePlanId?: string;
  },
): PushPayload {
  const link =
    input.windowId === undefined
      ? `/participants/${input.participantId}`
      : `/windows/${input.windowId}`;

  switch (kind) {
    case 'check_due':
      return {
        kind,
        title: 'Check due',
        body: `${input.participantName} has a check open now.`,
        url: link,
        tag: `due:${input.windowId ?? input.participantId}`,
      };
    case 'check_closing':
      return {
        kind,
        title: 'Check closing soon',
        body: `${input.participantName}, ${input.minutes ?? 0} minutes left.`,
        url: link,
        tag: `closing:${input.windowId ?? input.participantId}`,
      };
    case 'check_overdue':
      return {
        kind,
        title: 'Check missed',
        body: `${input.participantName} has a window that closed with nothing recorded.`,
        url: link,
        tag: `overdue:${input.windowId ?? input.participantId}`,
      };
    case 'escalation':
      return {
        kind,
        title: 'Missed check not resolved',
        body: `${input.participantName} still has an unresolved missed window.`,
        url: link,
        tag: `escalation:${input.windowId ?? input.participantId}`,
      };
    case 'sync_stale':
      return {
        kind,
        title: 'Records still waiting to send',
        body: 'Open Vigilo while you have signal so the records you saved can be sent.',
        url: '/today',
        tag: 'sync-stale',
      };
    case 'care_plan_published':
      return {
        kind,
        title: 'Care plan updated',
        body: `${input.participantName} has a new version of their care plan to read.`,
        // The plan, not the change summary: what changed is about a person and
        // a push payload is the one place that never goes (CLAUDE.md).
        url: `/participants/${input.participantId}?tab=care-plan`,
        tag: `care-plan:${input.carePlanId ?? input.participantId}`,
      };
  }
}
