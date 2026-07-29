import { describe, expect, it } from 'vitest';
import {
  buildNotification,
  defaultNotificationPreferences,
  notificationKinds,
  pushPayloadSchema,
  pushSafeName,
  pushSubscriptionRequestSchema,
} from './push.js';

describe('what a notification may name', () => {
  it('reduces a name to an initial and surname', () => {
    expect(pushSafeName('Aroha', 'Smith')).toBe('A. Smith');
  });

  it('copes with a single-name record', () => {
    expect(pushSafeName('Prince', '')).toBe('P.');
    expect(pushSafeName('', 'Nguyen')).toBe('Nguyen');
  });

  it('never returns an empty string to put in a notification body', () => {
    expect(pushSafeName('  ', '  ')).toBe('A participant');
  });
});

describe('notification payloads', () => {
  it('carries a deep link and no clinical detail', () => {
    const payload = buildNotification('check_overdue', {
      participantName: 'A. Smith',
      participantId: 'p1',
      windowId: 'w1',
    });
    expect(payload.url).toBe('/windows/w1');
    expect(payload.body).toContain('A. Smith');
    // The body says a window closed, never what was or was not observed.
    expect(payload.body).not.toMatch(/\d+\s*(bpm|mmHg|mg)/);
    expect(pushPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('falls back to the participant when there is no window', () => {
    const payload = buildNotification('check_due', {
      participantName: 'A. Smith',
      participantId: 'p1',
    });
    expect(payload.url).toBe('/participants/p1');
  });

  it('tags by subject so repeats collapse instead of stacking up', () => {
    const first = buildNotification('check_closing', {
      participantName: 'A. Smith',
      participantId: 'p1',
      windowId: 'w1',
      minutes: 20,
    });
    const second = buildNotification('check_closing', {
      participantName: 'A. Smith',
      participantId: 'p1',
      windowId: 'w1',
      minutes: 5,
    });
    expect(first.tag).toBe(second.tag);
  });

  it('names no participant in a sync warning, because it is about the device', () => {
    const payload = buildNotification('sync_stale', {
      participantName: 'A. Smith',
      participantId: 'p1',
    });
    expect(payload.body).not.toContain('Smith');
    expect(payload.url).toBe('/today');
  });

  it('produces a valid payload for every kind', () => {
    for (const kind of notificationKinds) {
      const payload = buildNotification(kind, {
        participantName: 'A. Smith',
        participantId: 'p1',
        windowId: 'w1',
        minutes: 10,
      });
      expect(pushPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe('preferences', () => {
  it('starts everything on, because the worker who has not thought about it needs them', () => {
    expect(Object.values(defaultNotificationPreferences).every(Boolean)).toBe(true);
  });

  it('has a toggle for every kind', () => {
    expect(Object.keys(defaultNotificationPreferences).sort()).toEqual(
      [...notificationKinds].sort(),
    );
  });
});

describe('subscriptions', () => {
  it('requires the keys the payload is encrypted to', () => {
    const parsed = pushSubscriptionRequestSchema.safeParse({
      deviceId: '01930000-0000-7000-8000-000000000001',
      endpoint: 'https://push.example.com/abc',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a subscription with no expiry, which is the usual case', () => {
    const parsed = pushSubscriptionRequestSchema.safeParse({
      deviceId: '01930000-0000-7000-8000-000000000001',
      endpoint: 'https://push.example.com/abc',
      p256dh: 'key',
      auth: 'auth',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.expirationTime).toBeNull();
  });
});
