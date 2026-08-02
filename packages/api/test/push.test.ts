import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { addDays, localDateOf } from '@vigilo/shared';
import {
  assign,
  createHarness,
  resetData,
  seedUser,
  signIn,
  VENT_SCHEMA,
  type Harness,
  type SignedIn,
} from './helpers.js';
import { materialiseParticipant, closeWindows } from '../src/services/windows.js';
import { runNotifications } from '../src/services/notifications.js';
import { notify, saveSubscription, type VapidKeys } from '../src/services/push.js';

const MELBOURNE = 'Australia/Melbourne';

const KEYS: VapidKeys = {
  publicKey: 'test-public',
  privateKey: 'test-private',
  subject: 'mailto:test@example.org',
};

/** Every send that reached the push service, and what was in it. */
const sends: { endpoint: string; body: string }[] = [];
/** Endpoints the fake push service refuses, and with what status. */
const failures = new Map<string, number>();

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'test-public', privateKey: 'test-private' }),
    sendNotification: (
      subscription: { endpoint: string },
      body: string,
    ): Promise<{ statusCode: number }> => {
      const status = failures.get(subscription.endpoint);
      if (status !== undefined) {
        return Promise.reject(Object.assign(new Error('push failed'), { statusCode: status }));
      }
      sends.push({ endpoint: subscription.endpoint, body });
      return Promise.resolve({ statusCode: 201 });
    },
  },
}));

/**
 * Push notifications (doc 04 §14, doc 07 §7).
 *
 * The push service itself is faked, because what is worth testing is what we
 * decide to send and to whom. The one rule that governs all of it: a payload
 * carries an initial and a surname at most, never anything clinical.
 */
describe('push', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
    sends.length = 0;
    failures.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function api(
    session: SignedIn,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
  ) {
    return request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
  }

  const today = () => localDateOf(new Date(), MELBOURNE);

  type Fixture = {
    admin: SignedIn;
    worker: SignedIn;
    workerId: string;
    deviceId: string;
    participantId: string;
  };

  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const participant = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Aroha',
      lastName: 'Smith',
      dateOfBirth: '1994-03-02',
      ndisNumber: '431234567',
    });
    const participantId = participant.body.participant.id as string;

    const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, workerUser.id, participantId);
    const worker = await signIn(h, workerUser);

    const deviceId = randomUUID();
    await api(worker, 'post', '/api/v1/devices').send({ deviceId, platform: 'android' });

    return { admin, worker, workerId: workerUser.id, deviceId, participantId };
  }

  async function subscribe(fixture: Fixture, endpoint: string): Promise<void> {
    await saveSubscription(h.db, fixture.workerId, {
      deviceId: fixture.deviceId,
      endpoint,
      p256dh: 'a-public-key',
      auth: 'an-auth-secret',
      expirationTime: null,
    });
  }

  /* --------------------------------------------------------- subscriptions */

  describe('subscriptions', () => {
    it('stores one against a registered device', async () => {
      const fixture = await setUp();

      const response = await api(fixture.worker, 'post', '/api/v1/push/subscriptions').send({
        deviceId: fixture.deviceId,
        endpoint: 'https://push.example.com/one',
        p256dh: 'key',
        auth: 'auth',
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
    });

    it('refuses a subscription for a device that is not registered', async () => {
      const fixture = await setUp();

      const response = await api(fixture.worker, 'post', '/api/v1/push/subscriptions').send({
        deviceId: randomUUID(),
        endpoint: 'https://push.example.com/two',
        p256dh: 'key',
        auth: 'auth',
      });

      expect(response.status).toBe(404);
    });

    it('re-registering the same endpoint updates rather than duplicates', async () => {
      const fixture = await setUp();
      const body = {
        deviceId: fixture.deviceId,
        endpoint: 'https://push.example.com/same',
        p256dh: 'key',
        auth: 'auth',
      };

      await api(fixture.worker, 'post', '/api/v1/push/subscriptions').send(body);
      await api(fixture.worker, 'post', '/api/v1/push/subscriptions').send({
        ...body,
        p256dh: 'rotated',
      });

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from push_subscriptions`,
      );
      // Otherwise the same worker gets the same notification twice, which is
      // the fastest way to have somebody turn notifications off.
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it('reports whether the deployment has keys at all', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'get', '/api/v1/push/vapid-key');

      // The harness configures no keys, and that is a real answer rather than
      // an error: a self-hosted install with none should still run.
      expect(response.status).toBe(200);
      expect(response.body.configured).toBe(false);
      expect(response.body.publicKey).toBeNull();
    });
  });

  /* ------------------------------------------------------------ preferences */

  describe('preferences', () => {
    it('starts with everything on', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'get', '/api/v1/me/notification-preferences');

      expect(response.status).toBe(200);
      expect(Object.values(response.body.preferences).every(Boolean)).toBe(true);
    });

    it('turns one kind off and leaves the rest alone', async () => {
      const fixture = await setUp();

      const response = await api(fixture.worker, 'put', '/api/v1/me/notification-preferences').send(
        { check_closing: false },
      );

      expect(response.body.preferences.check_closing).toBe(false);
      expect(response.body.preferences.check_overdue).toBe(true);
    });

    it('does not send a kind the user turned off', async () => {
      const fixture = await setUp();
      await subscribe(fixture, 'https://push.example.com/quiet');
      await api(fixture.worker, 'put', '/api/v1/me/notification-preferences').send({
        check_due: false,
      });

      const result = await notify(h.db, KEYS, fixture.workerId, 'check_due', randomUUID(), {
        kind: 'check_due',
        title: 'Check due',
        body: 'A. Smith has a check open now.',
        url: '/today',
        tag: 'due:1',
      });

      expect(result.sent).toBe(0);
      expect(sends).toHaveLength(0);
    });
  });

  /* --------------------------------------------------------------- sending */

  describe('sending', () => {
    it('sends once and never again for the same subject', async () => {
      const fixture = await setUp();
      await subscribe(fixture, 'https://push.example.com/once');
      const windowId = randomUUID();
      const payload = {
        kind: 'check_overdue' as const,
        title: 'Check missed',
        body: 'A. Smith has a window that closed with nothing recorded.',
        url: `/windows/${windowId}`,
        tag: `overdue:${windowId}`,
      };

      const first = await notify(h.db, KEYS, fixture.workerId, 'check_overdue', windowId, payload);
      const second = await notify(h.db, KEYS, fixture.workerId, 'check_overdue', windowId, payload);

      expect(first.sent).toBe(1);
      expect(second.sent).toBe(0);
      expect(sends).toHaveLength(1);
    });

    it('prunes an endpoint the push service says is gone', async () => {
      const fixture = await setUp();
      await subscribe(fixture, 'https://push.example.com/dead');
      failures.set('https://push.example.com/dead', 410);

      const result = await notify(h.db, KEYS, fixture.workerId, 'check_due', randomUUID(), {
        kind: 'check_due',
        title: 'Check due',
        body: 'A. Smith has a check open now.',
        url: '/today',
        tag: 'due:1',
      });

      expect(result.pruned).toBe(1);
      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from push_subscriptions`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('keeps a subscription through a transient failure', async () => {
      const fixture = await setUp();
      await subscribe(fixture, 'https://push.example.com/flaky');
      failures.set('https://push.example.com/flaky', 503);

      const result = await notify(h.db, KEYS, fixture.workerId, 'check_due', randomUUID(), {
        kind: 'check_due',
        title: 'Check due',
        body: 'A. Smith has a check open now.',
        url: '/today',
        tag: 'due:1',
      });

      // A push service having a bad five minutes is not a reason to stop
      // notifying somebody forever.
      expect(result.pruned).toBe(0);
      const rows = await h.ownerDb.execute<{ failure_count: number }>(
        sql`select failure_count from push_subscriptions`,
      );
      expect(rows[0]!.failure_count).toBe(1);
    });

    it('does nothing at all when no keys are configured', async () => {
      const fixture = await setUp();
      await subscribe(fixture, 'https://push.example.com/nokeys');

      const result = await notify(h.db, null, fixture.workerId, 'check_due', randomUUID(), {
        kind: 'check_due',
        title: 'Check due',
        body: 'A. Smith has a check open now.',
        url: '/today',
        tag: 'due:1',
      });

      expect(result.sent).toBe(0);
      expect(sends).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------- the job */

  describe('the notification job', () => {
    async function withWindows(fixture: Fixture): Promise<void> {
      const template = await api(fixture.admin, 'post', '/api/v1/check-templates').send({
        name: 'Vent observations',
      });
      const templateId = template.body.template.id as string;
      const versionId = template.body.template.draftVersion.id as string;
      await api(fixture.admin, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
        schema: VENT_SCHEMA,
      });
      await api(fixture.admin, 'post', `/api/v1/check-template-versions/${versionId}/publish`).send(
        {},
      );
      await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/schedules`)
        .send({
          templateId,
          name: 'Hourly observations',
          activeFrom: addDays(today(), -2),
          segments: [
            {
              label: 'All day',
              windowMinutes: 60,
              anchorTime: '00:00',
              appliesFromTime: '00:00',
              appliesToTime: '24:00',
            },
          ],
        })
        .expect(201);
      /*
       * Laid as of the first day in the range. The materialiser refuses to lay
       * a window that has already closed (D85), so a test that needs history
       * says when it is pretending to be.
       */
      const from = addDays(today(), -2);
      await materialiseParticipant(
        h.db,
        fixture.participantId,
        from,
        today(),
        new Date(`${from}T00:00:00Z`),
      );
    }

    it('tells the assigned worker about an open window and nobody else', async () => {
      const fixture = await setUp();
      await withWindows(fixture);
      await subscribe(fixture, 'https://push.example.com/worker');

      const otherUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const other = await signIn(h, otherUser);
      const otherDevice = randomUUID();
      await api(other, 'post', '/api/v1/devices').send({
        deviceId: otherDevice,
        platform: 'android',
      });
      await saveSubscription(h.db, otherUser.id, {
        deviceId: otherDevice,
        endpoint: 'https://push.example.com/stranger',
        p256dh: 'key',
        auth: 'auth',
        expirationTime: null,
      });

      const run = await runNotifications(h.db, h.keyRing, KEYS);

      expect(run.due).toBeGreaterThan(0);
      expect(sends.every((one) => one.endpoint === 'https://push.example.com/worker')).toBe(true);
    });

    it('never puts a full name or anything clinical in a payload', async () => {
      const fixture = await setUp();
      await withWindows(fixture);
      await subscribe(fixture, 'https://push.example.com/safe');

      await runNotifications(h.db, h.keyRing, KEYS);

      expect(sends.length).toBeGreaterThan(0);
      for (const sent of sends) {
        const payload = JSON.parse(sent.body) as { body: string; url: string };
        expect(payload.body).toContain('A. Smith');
        expect(payload.body).not.toContain('Aroha');
        expect(payload.body).not.toContain('431234567');
        expect(payload.url.startsWith('/')).toBe(true);
      }
    });

    it('does not notify twice when the job runs again', async () => {
      const fixture = await setUp();
      await withWindows(fixture);
      await subscribe(fixture, 'https://push.example.com/repeat');

      await runNotifications(h.db, h.keyRing, KEYS);
      const afterFirst = sends.length;
      await runNotifications(h.db, h.keyRing, KEYS);

      expect(sends).toHaveLength(afterFirst);
    });

    it('escalates a missed window nobody has resolved to an admin', async () => {
      const fixture = await setUp();
      await withWindows(fixture);
      await closeWindows(h.db);
      await subscribe(fixture, 'https://push.example.com/worker');

      const adminUsers = await h.ownerDb.execute<{ id: string }>(
        sql`select id from users where role = 'admin' limit 1`,
      );
      const adminId = adminUsers[0]!.id;
      const adminDevice = randomUUID();
      await h.ownerDb.execute(
        sql`insert into devices (id, user_id, platform) values (${adminDevice}::uuid, ${adminId}::uuid, 'web')`,
      );
      await saveSubscription(h.db, adminId, {
        deviceId: adminDevice,
        endpoint: 'https://push.example.com/admin',
        p256dh: 'key',
        auth: 'auth',
        expirationTime: null,
      });

      const run = await runNotifications(h.db, h.keyRing, KEYS);

      expect(run.overdue).toBeGreaterThan(0);
      expect(run.escalated).toBeGreaterThan(0);
      expect(sends.some((one) => one.endpoint === 'https://push.example.com/admin')).toBe(true);
    });

    it('does nothing when the deployment has no keys', async () => {
      const fixture = await setUp();
      await withWindows(fixture);
      await subscribe(fixture, 'https://push.example.com/none');

      const run = await runNotifications(h.db, h.keyRing, null);

      expect(run).toEqual({ due: 0, closing: 0, overdue: 0, escalated: 0, pruned: 0 });
      expect(sends).toHaveLength(0);
    });
  });
});
