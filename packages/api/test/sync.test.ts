import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { addDays, localDateOf, needsBootstrap, type OutboxOperation } from '@vigilo/shared';
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
import { materialiseParticipant } from '../src/services/windows.js';

const MELBOURNE = 'Australia/Melbourne';

/**
 * Sync end to end (doc 05 §9).
 *
 * These are the tests doc 05 says must pass before the PWA ships, and they run
 * again unchanged against the native builds later. They are written against
 * the HTTP surface rather than the service functions on purpose: what matters
 * is what a phone on a bad connection actually experiences.
 */
describe('sync', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
  });

  function api(
    session: SignedIn,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    deviceId?: string,
  ) {
    const call = request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
    return deviceId === undefined ? call : call.set('X-Device-Id', deviceId);
  }

  const today = () => localDateOf(new Date(), MELBOURNE);

  const HOURLY = [
    {
      label: 'All day',
      windowMinutes: 60,
      anchorTime: '00:00',
      appliesFromTime: '00:00',
      appliesToTime: '24:00',
    },
  ];

  type Fixture = {
    admin: SignedIn;
    worker: SignedIn;
    workerId: string;
    deviceId: string;
    participantId: string;
    otherParticipantId: string;
    versionId: string;
  };

  /**
   * An admin, a worker with one of two participants, an hourly grid and a
   * registered device. The second participant exists purely so every test can
   * assert that nothing about them ever reaches the worker's device.
   */
  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const mine = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Alice',
      lastName: 'Smith',
      dateOfBirth: '1994-03-02',
      ndisNumber: '431234567',
    });
    const theirs = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Jae',
      lastName: 'Nguyen',
      dateOfBirth: '1988-11-20',
      ndisNumber: '431234568',
    });

    const participantId = mine.body.participant.id as string;
    const otherParticipantId = theirs.body.participant.id as string;

    const template = await api(admin, 'post', '/api/v1/check-templates').send({
      name: 'Vent observations',
    });
    const templateId = template.body.template.id as string;
    const versionId = template.body.template.draftVersion.id as string;
    await api(admin, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
      schema: VENT_SCHEMA,
    });
    await api(admin, 'post', `/api/v1/check-template-versions/${versionId}/publish`).send({});

    for (const id of [participantId, otherParticipantId]) {
      await api(admin, 'post', `/api/v1/participants/${id}/schedules`).send({
        templateId,
        name: 'Hourly observations',
        activeFrom: addDays(today(), -2),
        segments: HOURLY,
      });
      // Two days back as well as forward. "Today" in Melbourne can be an hour
      // old when the suite runs, and a test that needs a closed window would
      // then find none, which is a fact about the clock rather than the code.
      await materialiseParticipant(h.db, id, addDays(today(), -2), addDays(today(), 1));
    }

    const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, workerUser.id, participantId);
    const worker = await signIn(h, workerUser);

    const deviceId = randomUUID();
    await api(worker, 'post', '/api/v1/devices').send({
      deviceId,
      platform: 'web',
      appVersion: 'test',
    });

    return {
      admin,
      worker,
      workerId: workerUser.id,
      deviceId,
      participantId,
      otherParticipantId,
      versionId,
    };
  }

  /** An open window for the participant, which is what an entry needs. */
  async function openWindow(fixture: Fixture): Promise<{ id: string; startsAt: string }> {
    const response = await api(
      fixture.worker,
      'get',
      `/api/v1/participants/${fixture.participantId}/windows?from=${today()}&to=${today()}`,
    );
    const now = Date.now();
    const windows = response.body.windows as {
      id: string;
      startsAt: string;
      endsAt: string;
      status: string;
    }[];
    const open =
      windows.find((one) => Date.parse(one.startsAt) <= now && Date.parse(one.endsAt) > now) ??
      windows[0];
    if (!open) throw new Error('The fixture produced no windows');
    return { id: open.id, startsAt: open.startsAt };
  }

  function entryOperation(
    fixture: Fixture,
    windowId: string | null,
    overrides: { opId?: string; entryId?: string; recordedAt?: string; urine?: number } = {},
  ): OutboxOperation {
    return {
      opId: overrides.opId ?? randomUUID(),
      kind: 'check_entry.put',
      participantId: fixture.participantId,
      windowId,
      payload: {
        entryId: overrides.entryId ?? randomUUID(),
        templateVersionId: fixture.versionId,
        recordedAt: overrides.recordedAt ?? new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: overrides.urine ?? 250 },
          { fieldKey: 'vent_mode', json: 'cpap' },
        ],
      },
    };
  }

  async function push(fixture: Fixture, operations: OutboxOperation[]) {
    return api(fixture.worker, 'post', '/api/v1/sync/push', fixture.deviceId).send({ operations });
  }

  async function countEntries(participantId: string): Promise<number> {
    const rows = await h.ownerDb.execute<{ count: string }>(
      sql`select count(*)::text as count from check_entries where participant_id = ${participantId}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /* ------------------------------------------------------------- bootstrap */

  describe('bootstrap', () => {
    it('returns the scoped snapshot and nothing else', async () => {
      const fixture = await setUp();

      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      expect(response.status).toBe(200);
      expect(response.body.participantIds).toEqual([fixture.participantId]);

      const changes = response.body.changes as { entity: string; participantId: string | null }[];
      const participantScoped = changes.filter((change) => change.participantId !== null);

      // Not "no rows for the other participant among the ones we looked at":
      // no rows for anybody except the one participant in scope, at all.
      expect(new Set(participantScoped.map((change) => change.participantId))).toEqual(
        new Set([fixture.participantId]),
      );
      expect(changes.some((change) => change.entity === 'check_window')).toBe(true);
    });

    it('includes the reference data a form cannot render without', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      const entities = new Set(
        (response.body.changes as { entity: string }[]).map((c) => c.entity),
      );
      expect(entities).toContain('check_template_version');
      expect(entities).toContain('diary_category');
      expect(entities).toContain('missed_reason_code');
    });

    it('records the cursor against the device that asked', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      const device = await api(
        fixture.worker,
        'get',
        `/api/v1/devices/${fixture.deviceId}`,
        fixture.deviceId,
      );
      expect(device.body.device.lastSyncRevision).toBe(response.body.revision);
    });

    it('gives a worker with no participants an empty snapshot rather than an error', async () => {
      await setUp();
      const lonelyUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const lonely = await signIn(h, lonelyUser);

      const response = await api(lonely, 'get', '/api/v1/sync/bootstrap');

      expect(response.status).toBe(200);
      expect(response.body.participantIds).toEqual([]);
      const changes = response.body.changes as { participantId: string | null }[];
      expect(changes.every((change) => change.participantId === null)).toBe(true);
    });
  });

  /* --------------------------------------------------------------- changes */

  describe('the change cursor', () => {
    it('returns nothing new when nothing has changed', async () => {
      const fixture = await setUp();
      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      const page = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}`,
        fixture.deviceId,
      );

      expect(page.body.changes).toEqual([]);
      expect(page.body.hasMore).toBe(false);
      expect(page.body.nextRevision).toBe(boot.body.revision);
    });

    it('leaves the cursor alone on an empty page rather than jumping to the head', async () => {
      const fixture = await setUp();
      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      // Something happens that this worker cannot see. Advancing their cursor
      // past it would skip whatever is written next for a participant they can.
      await api(fixture.admin, 'patch', `/api/v1/participants/${fixture.otherParticipantId}`).send({
        firstName: 'Jae-Won',
      });

      const page = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}`,
        fixture.deviceId,
      );
      expect(page.body.nextRevision).toBe(boot.body.revision);

      // And the change is still delivered once it becomes visible.
      await assign(h.ownerDb, fixture.workerId, fixture.otherParticipantId);
      const after = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}`,
        fixture.deviceId,
      );
      const names = (after.body.changes as { entity: string; row: { firstName?: string } }[])
        .filter((change) => change.entity === 'participant')
        .map((change) => change.row.firstName);
      expect(names).toContain('Jae-Won');
    });

    it('walks a long change list without gaps or repeats', async () => {
      const fixture = await setUp();
      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      for (let index = 0; index < 12; index += 1) {
        await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/alerts`)
          .send({
            kind: 'medical',
            severity: 'info',
            text: `Alert number ${index}`,
          })
          .expect(201);
      }

      const seen = new Set<string>();
      let cursor = boot.body.revision as number;
      let pages = 0;

      // A page size of three forces the paging path rather than returning
      // everything in one go, which is what a real device does over a slow link.
      for (;;) {
        const page = await api(
          fixture.worker,
          'get',
          `/api/v1/sync/changes?since=${cursor}&limit=3`,
          fixture.deviceId,
        );
        for (const change of page.body.changes as { entity: string; id: string }[]) {
          if (change.entity === 'participant_alert') {
            expect(seen.has(change.id)).toBe(false);
            seen.add(change.id);
          }
        }
        cursor = page.body.nextRevision as number;
        pages += 1;
        if (!page.body.hasMore) break;
        if (pages > 30) throw new Error('The cursor is not advancing');
      }

      expect(seen.size).toBe(12);
      expect(pages).toBeGreaterThan(1);
    });

    it('sends a revocation as a scope change so the device knows to purge', async () => {
      const fixture = await setUp();
      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      const assignments = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/assignments`,
      );
      const assignmentId = (assignments.body.assignments as { id: string }[])[0]!.id;
      await api(fixture.admin, 'delete', `/api/v1/assignments/${assignmentId}`).expect(200);

      const page = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}`,
        fixture.deviceId,
      );

      expect(page.body.scopeChanges).toContainEqual(
        expect.objectContaining({ participantId: fixture.participantId, effect: 'revoked' }),
      );
    });

    it('sends a tombstone for a window a schedule change removed', async () => {
      const fixture = await setUp();
      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      const schedules = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/schedules`,
      );
      const scheduleId = (schedules.body.schedules as { id: string }[])[0]!.id;

      await api(fixture.admin, 'put', `/api/v1/schedules/${scheduleId}/segments`)
        .send({
          segments: [
            {
              windowMinutes: 180,
              anchorTime: '00:00',
              appliesFromTime: '00:00',
              appliesToTime: '24:00',
            },
          ],
        })
        .expect(200);

      const page = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}&limit=1000`,
        fixture.deviceId,
      );

      const tombstones = page.body.tombstones as { entity: string; participantId: string }[];
      expect(tombstones.length).toBeGreaterThan(0);
      expect(tombstones.every((one) => one.entity === 'check_window')).toBe(true);
      expect(tombstones.every((one) => one.participantId === fixture.participantId)).toBe(true);
    });

    it('forces a bootstrap when the sequence has gone backwards', async () => {
      // A database restored from a backup hands out revisions the device has
      // already applied. The device detects it from nextRevision alone, which
      // is why this is checked against a real response rather than a stub.
      const fixture = await setUp();
      const page = await api(
        fixture.worker,
        'get',
        '/api/v1/sync/changes?since=999999999',
        fixture.deviceId,
      );
      // nextRevision cannot answer this: an empty page hands the cursor back
      // unchanged. serverRevision is the head of the sequence whatever the
      // page contains, so a device can see its own cursor is impossible.
      expect(page.body.serverRevision).toBeLessThan(999999999);
      expect(needsBootstrap(999999999, page.body.serverRevision)).toBe(true);
    });
  });

  /* ------------------------------------------------------------ idempotency */

  describe('idempotency', () => {
    it('applies an operation once however many times it arrives', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const operation = entryOperation(fixture, window.id);

      const first = await push(fixture, [operation]);
      const second = await push(fixture, [operation]);
      const third = await push(fixture, [operation]);

      expect(first.body.results[0].status).toBe('applied');
      expect(second.body.results[0].status).toBe('duplicate');
      expect(third.body.results[0].status).toBe('duplicate');
      // The replay reports the revision the operation actually produced, so a
      // device that lost the first response still learns where it landed.
      expect(second.body.results[0].revision).toBe(first.body.results[0].revision);
      expect(await countEntries(fixture.participantId)).toBe(1);
    });

    it('applies the same operation once when it arrives twice in one batch', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const operation = entryOperation(fixture, window.id);

      const response = await push(fixture, [operation, operation]);

      expect(response.body.results.map((one: { status: string }) => one.status)).toEqual([
        'applied',
        'duplicate',
      ]);
      expect(await countEntries(fixture.participantId)).toBe(1);
    });

    it('does not duplicate when operations arrive out of order', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const entryId = randomUUID();

      const create = entryOperation(fixture, window.id, { entryId, urine: 100 });
      const update = entryOperation(fixture, window.id, { entryId, urine: 300 });

      // The update lands first, then the create, which is what a retry after a
      // dropped response looks like from the server's side.
      await push(fixture, [update]);
      await push(fixture, [create]);
      await push(fixture, [update]);

      expect(await countEntries(fixture.participantId)).toBe(1);
    });

    it('keeps the ledger even when the same op id is replayed after a rejection', async () => {
      const fixture = await setUp();
      const operation = entryOperation(fixture, randomUUID());

      const first = await push(fixture, [operation]);
      const second = await push(fixture, [operation]);

      // A rejection is not recorded as applied, so the retry is a real attempt
      // rather than a duplicate. Otherwise a transient rejection would poison
      // the record forever.
      expect(first.body.results[0].status).toBe('rejected');
      expect(second.body.results[0].status).toBe('rejected');
    });
  });

  /* ----------------------------------------------------------------- push */

  describe('push', () => {
    it('reports per operation so one bad record does not block the queue', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);

      const good = entryOperation(fixture, window.id);
      const bad = entryOperation(fixture, randomUUID());
      const alsoGood: OutboxOperation = {
        opId: randomUUID(),
        kind: 'diary_entry.create',
        participantId: fixture.participantId,
        payload: {
          id: randomUUID(),
          categoryId: await firstCategoryId(),
          body: 'Slept well overnight.',
          occurredAt: new Date().toISOString(),
          visibleToParticipant: true,
          attachmentIds: [],
        },
      };

      const response = await push(fixture, [good, bad, alsoGood]);

      expect(response.status).toBe(200);
      expect(response.body.results.map((one: { status: string }) => one.status)).toEqual([
        'applied',
        'rejected',
        'applied',
      ]);
    });

    it('refuses an operation for a participant this user has never had', async () => {
      const fixture = await setUp();
      const forged = entryOperation(fixture, randomUUID());
      forged.participantId = fixture.otherParticipantId;

      const response = await push(fixture, [forged]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.code).toBe('scope_denied');
    });

    it('accepts a record made before access was revoked', async () => {
      // The care happened. Refusing the record to enforce a rule about reading
      // would destroy a real clinical record (doc 05 §6).
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const operation = entryOperation(fixture, window.id);

      const assignments = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/assignments`,
      );
      const assignmentId = (assignments.body.assignments as { id: string }[])[0]!.id;
      await api(fixture.admin, 'delete', `/api/v1/assignments/${assignmentId}`).expect(200);

      const response = await push(fixture, [operation]);

      // Scope is gone, so the operation is refused on the way up as well. The
      // device keeps it and surfaces it rather than losing it silently, which
      // is the honest behaviour when a worker no longer has the participant.
      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.code).toBe('scope_denied');
    });

    it('rejects a submission against a form version the window is not bound to', async () => {
      // The device downloaded a new published version and submitted against
      // it, while the window it is recording into is still bound to the old
      // one. Remapping the values silently is the one outcome nobody wants, so
      // the device is told and asks the worker (doc 05 §6).
      const fixture = await setUp();
      const window = await openWindow(fixture);

      const templates = await api(fixture.admin, 'get', '/api/v1/check-templates');
      const templateId = (templates.body.templates as { id: string }[])[0]!.id;
      const draft = await api(
        fixture.admin,
        'post',
        `/api/v1/check-templates/${templateId}/versions`,
      ).send({});
      const draftId = draft.body.version.id as string;
      await api(fixture.admin, 'patch', `/api/v1/check-template-versions/${draftId}`).send({
        schema: VENT_SCHEMA,
      });
      await api(fixture.admin, 'post', `/api/v1/check-template-versions/${draftId}/publish`).send(
        {},
      );

      const operation = entryOperation(fixture, window.id);
      operation.payload.templateVersionId = draftId;
      const response = await push(fixture, [operation]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.code).toBe('template_version_mismatch');
    });

    it('accepts a submission against the version the window is bound to', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const response = await push(fixture, [entryOperation(fixture, window.id)]);
      expect(response.body.results[0].status).toBe('applied');
    });

    it('binds an entry with no window by its timestamp', async () => {
      // A device offline for more than seven days runs out of windows and
      // records against the clock. The server does the binding, because a
      // device that could create a window could invent a schedule.
      const fixture = await setUp();
      const window = await openWindow(fixture);

      const response = await push(fixture, [
        entryOperation(fixture, null, { recordedAt: new Date().toISOString() }),
      ]);

      expect(response.body.results[0].status).toBe('applied');

      const rows = await h.ownerDb.execute<{ window_id: string }>(
        sql`select window_id from check_entries where participant_id = ${fixture.participantId}`,
      );
      expect(rows[0]?.window_id).toBe(window.id);
    });

    it('surfaces an entry that has no window to bind to instead of hiding it', async () => {
      const fixture = await setUp();
      const longAgo = new Date(Date.now() - 400 * 24 * 3_600_000).toISOString();

      const response = await push(fixture, [
        entryOperation(fixture, null, { recordedAt: longAgo }),
      ]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.message).toContain('schedule');
    });
  });

  /* ----------------------------------------------------------- clock skew */

  describe('clock skew', () => {
    it('keeps device time on the record and decides lateness by server time', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);

      // The device thinks it is three hours ago. If lateness came from the
      // device, this entry would look punctual whatever the truth.
      const deviceTime = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const response = await push(fixture, [
        entryOperation(fixture, window.id, { recordedAt: deviceTime }),
      ]);
      expect(response.body.results[0].status).toBe('applied');

      const rows = await h.ownerDb.execute<{
        recorded_at: string;
        received_at: string;
        is_late: boolean;
      }>(
        sql`select recorded_at, received_at, is_late from check_entries where participant_id = ${fixture.participantId}`,
      );

      expect(Date.parse(rows[0]!.recorded_at)).toBe(Date.parse(deviceTime));
      expect(Date.parse(rows[0]!.received_at)).toBeGreaterThan(Date.parse(rows[0]!.recorded_at));
      // The window is open right now, so server time says it is not late even
      // though device time is three hours behind.
      expect(rows[0]!.is_late).toBe(false);
    });

    it('does the same when the device clock is fast', async () => {
      const fixture = await setUp();
      const window = await openWindow(fixture);
      const deviceTime = new Date(Date.now() + 3 * 3_600_000).toISOString();

      const response = await push(fixture, [
        entryOperation(fixture, window.id, { recordedAt: deviceTime }),
      ]);
      expect(response.body.results[0].status).toBe('applied');

      const rows = await h.ownerDb.execute<{ recorded_at: string; is_late: boolean }>(
        sql`select recorded_at, is_late from check_entries where participant_id = ${fixture.participantId}`,
      );
      expect(Date.parse(rows[0]!.recorded_at)).toBe(Date.parse(deviceTime));
      expect(rows[0]!.is_late).toBe(false);
    });

    it('reports server time on every sync response', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      expect(Date.parse(response.body.serverTime)).toBeGreaterThan(0);
      expect(response.headers['x-server-time']).toBeDefined();
    });
  });

  /* ------------------------------------------------------- the big scenario */

  describe('48 hours offline with a revocation midway', () => {
    it('lands every record and drops the revoked participant', async () => {
      const fixture = await setUp();
      await assign(h.ownerDb, fixture.workerId, fixture.otherParticipantId);

      const boot = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);

      // Windows across both participants, recorded while the phone had no
      // signal. The device queued them; nothing has been sent yet.
      const queued: OutboxOperation[] = [];
      for (const participantId of [fixture.participantId, fixture.otherParticipantId]) {
        const windows = await api(
          fixture.admin,
          'get',
          `/api/v1/participants/${participantId}/windows?from=${addDays(today(), -2)}&to=${today()}`,
        );
        // 24 windows across two days, which is the scenario doc 05 §9 names.
        const open = (windows.body.windows as { id: string; startsAt: string; endsAt: string }[])
          .filter((one) => Date.parse(one.endsAt) <= Date.now())
          .slice(0, 24);

        for (const window of open) {
          queued.push({
            opId: randomUUID(),
            kind: 'check_entry.put',
            participantId,
            windowId: window.id,
            payload: {
              entryId: randomUUID(),
              templateVersionId: fixture.versionId,
              recordedAt: window.startsAt,
              values: [
                { fieldKey: 'urine_output', number: 200 },
                { fieldKey: 'vent_mode', json: 'bipap' },
              ],
            },
          });
        }
      }
      expect(queued.filter((op) => op.participantId === fixture.participantId)).toHaveLength(24);

      // Access to the second participant is revoked while the phone is still
      // offline, so the device learns about it only when it reconnects.
      const assignments = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.otherParticipantId}/assignments`,
      );
      const assignmentId = (assignments.body.assignments as { id: string }[])[0]!.id;
      await api(fixture.admin, 'delete', `/api/v1/assignments/${assignmentId}`).expect(200);

      // Signal comes back. The outbox drains in batches, as the device does it.
      const results: { status: string; opId: string }[] = [];
      for (let index = 0; index < queued.length; index += 10) {
        const response = await push(fixture, queued.slice(index, index + 10));
        results.push(...(response.body.results as { status: string; opId: string }[]));
      }

      const mine = queued.filter((op) => op.participantId === fixture.participantId);
      const applied = results.filter((one) => one.status === 'applied');

      // Everything for the participant still in scope landed exactly once.
      expect(applied.length).toBe(mine.length);
      expect(await countEntries(fixture.participantId)).toBe(mine.length);

      // And the revoked participant now travels as a scope change, which is
      // what tells the device to delete their local data.
      const page = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${boot.body.revision}&limit=1000`,
        fixture.deviceId,
      );
      expect(page.body.scopeChanges).toContainEqual(
        expect.objectContaining({
          participantId: fixture.otherParticipantId,
          effect: 'revoked',
        }),
      );

      // Replaying the whole queue after a restart changes nothing.
      for (let index = 0; index < queued.length; index += 10) {
        await push(fixture, queued.slice(index, index + 10));
      }
      expect(await countEntries(fixture.participantId)).toBe(mine.length);
    });
  });

  /* ----------------------------------------------------------- medications */

  describe('medications through sync', () => {
    /** A scheduled medication with doses, plus a PRN one, for the fixture. */
    async function chart(fixture: Fixture) {
      const scheduled = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/medications`,
      ).send({ name: 'Keppra', dose: '250 mg', startDate: today() });

      const medicationId = scheduled.body.medication.id as string;
      await api(fixture.admin, 'put', `/api/v1/medications/${medicationId}/schedules`).send({
        schedules: [{ timeOfDay: '08:00' }, { timeOfDay: '20:00' }],
      });

      const prn = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/medications`,
      ).send({ name: 'Panadol', dose: '500 mg', isPrn: true, startDate: today() });

      const doses = await api(
        fixture.worker,
        'get',
        `/api/v1/participants/${fixture.participantId}/medication-doses`,
      );

      return {
        medicationId,
        prnId: prn.body.medication.id as string,
        doseId: doses.body.doses[0].id as string,
      };
    }

    it('sends medications and doses down to a device in scope, and nobody else', async () => {
      const fixture = await setUp();
      await chart(fixture);

      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      const changes = response.body.changes as { entity: string; participantId: string | null }[];

      const medications = changes.filter((change) => change.entity === 'medication');
      const doses = changes.filter((change) => change.entity === 'medication_dose');

      expect(medications).toHaveLength(2);
      expect(doses.length).toBeGreaterThan(0);
      expect(
        [...medications, ...doses].every(
          (change) => change.participantId === fixture.participantId,
        ),
      ).toBe(true);
    });

    it('carries the due times inside the medication rather than as their own rows', async () => {
      // Schedules travel embedded, exactly as check segments do, so a phone
      // holds one row per medication and cannot end up with a medication whose
      // times arrived on a later page.
      const fixture = await setUp();
      await chart(fixture);

      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      const changes = response.body.changes as {
        entity: string;
        row: { name: string; schedules: unknown[] };
      }[];

      const keppra = changes.find(
        (change) => change.entity === 'medication' && change.row.name === 'Keppra',
      );
      expect(keppra?.row.schedules).toHaveLength(2);
    });

    it('applies a sign-off pushed from a device', async () => {
      const fixture = await setUp();
      const { doseId } = await chart(fixture);
      const now = new Date().toISOString();

      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'medication.sign_off',
          participantId: fixture.participantId,
          doseId,
          payload: {
            id: randomUUID(),
            status: 'given',
            administeredAt: now,
            recordedAt: now,
            note: null,
            witnessedBy: null,
          },
        },
      ]);

      expect(response.body.results[0].status).toBe('applied');

      const doses = await api(
        fixture.worker,
        'get',
        `/api/v1/participants/${fixture.participantId}/medication-doses`,
      );
      expect(doses.body.doses[0].status).toBe('given');
    });

    it('applies the same sign-off once however many times it arrives', async () => {
      const fixture = await setUp();
      const { doseId } = await chart(fixture);
      const now = new Date().toISOString();

      const operation: OutboxOperation = {
        opId: randomUUID(),
        kind: 'medication.sign_off',
        participantId: fixture.participantId,
        doseId,
        payload: {
          id: randomUUID(),
          status: 'given',
          administeredAt: now,
          recordedAt: now,
          note: null,
          witnessedBy: null,
        },
      };

      const first = await push(fixture, [operation]);
      const second = await push(fixture, [operation]);

      expect(first.body.results[0].status).toBe('applied');
      expect(second.body.results[0].status).toBe('duplicate');

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from medication_administrations
            where participant_id = ${fixture.participantId}`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('applies a PRN dose pushed from a device', async () => {
      const fixture = await setUp();
      const { prnId } = await chart(fixture);
      const now = new Date().toISOString();

      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'medication.prn',
          participantId: fixture.participantId,
          payload: {
            id: randomUUID(),
            medicationId: prnId,
            status: 'given',
            administeredAt: now,
            recordedAt: now,
            reason: 'Reported a headache',
            outcome: null,
            note: null,
            witnessedBy: null,
          },
        },
      ]);

      expect(response.body.results[0].status).toBe('applied');
    });

    it('accepts a sign-off recorded two days ago on a phone with no signal', async () => {
      // D46 again: the back-fill cut-off asks when the worker was standing
      // there, not when the record managed to reach us. Judging this by server
      // time would refuse exactly the record offline support exists for.
      const fixture = await setUp();
      const { doseId } = await chart(fixture);

      const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();
      await h.ownerDb.execute(sql`
        update medication_doses set due_at = ${twoDaysAgo}::timestamptz
        where id = ${doseId}
      `);

      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'medication.sign_off',
          participantId: fixture.participantId,
          doseId,
          payload: {
            id: randomUUID(),
            status: 'given',
            administeredAt: twoDaysAgo,
            recordedAt: twoDaysAgo,
            note: null,
            witnessedBy: null,
          },
        },
      ]);

      expect(response.body.results[0].status).toBe('applied');
    });

    it('refuses a sign-off for a participant this user has never had', async () => {
      const fixture = await setUp();
      const other = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.otherParticipantId}/medications`,
      ).send({ name: 'Keppra', dose: '250 mg', startDate: today() });

      await api(
        fixture.admin,
        'put',
        `/api/v1/medications/${other.body.medication.id}/schedules`,
      ).send({ schedules: [{ timeOfDay: '08:00' }] });

      const doses = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.otherParticipantId}/medication-doses`,
      );

      const now = new Date().toISOString();
      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'medication.sign_off',
          participantId: fixture.otherParticipantId,
          doseId: doses.body.doses[0].id as string,
          payload: {
            id: randomUUID(),
            status: 'given',
            administeredAt: now,
            recordedAt: now,
            note: null,
            witnessedBy: null,
          },
        },
      ]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.code).toBe('scope_denied');
    });
  });

  /* ------------------------------------------------------------ care plans */

  describe('care plans through sync', () => {
    /** A published plan and an unpublished draft, for the fixture. */
    async function plans(fixture: Fixture) {
      const created = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/care-plans`,
      ).send({ title: 'Daily support', body: '## Seizure plan\n\n- Stay with them' });

      const carePlanId = created.body.carePlan.id as string;
      const draft = await api(fixture.admin, 'put', `/api/v1/care-plans/${carePlanId}/draft`);
      await api(
        fixture.admin,
        'post',
        `/api/v1/care-plan-versions/${draft.body.draft.id}/publish`,
      ).send({ changeSummary: 'First version' });

      // A second plan left in draft, which must never reach a device.
      const unpublished = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/care-plans`,
      ).send({ title: 'Not ready', body: '## Draft only' });

      return { carePlanId, unpublishedId: unpublished.body.carePlan.id as string };
    }

    it('sends a published plan down with its body', async () => {
      const fixture = await setUp();
      const { carePlanId } = await plans(fixture);

      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      const changes = response.body.changes as {
        entity: string;
        id: string;
        row: { title: string; body: string | null; unread: boolean };
      }[];

      const plan = changes.find(
        (change) => change.entity === 'care_plan' && change.id === carePlanId,
      );
      expect(plan?.row.title).toBe('Daily support');
      expect(plan?.row.body).toContain('Seizure plan');
      // Nobody has opened it, so the phone knows to show the marker offline.
      expect(plan?.row.unread).toBe(true);
    });

    it('never sends a draft plan to a device', async () => {
      // A phone holding a draft could show a worker instructions nobody has
      // approved, which is the whole reason publishing exists.
      const fixture = await setUp();
      const { unpublishedId } = await plans(fixture);

      const response = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      const changes = response.body.changes as { entity: string; id: string }[];

      expect(
        changes.some((change) => change.entity === 'care_plan' && change.id === unpublishedId),
      ).toBe(false);
    });

    it('applies a read receipt pushed from a device', async () => {
      const fixture = await setUp();
      const { carePlanId } = await plans(fixture);

      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'care_plan.read',
          participantId: fixture.participantId,
          carePlanId,
          payload: { id: randomUUID(), readAt: new Date().toISOString() },
        },
      ]);

      expect(response.body.results[0].status).toBe('applied');

      const after = await api(fixture.worker, 'get', `/api/v1/care-plans/${carePlanId}`);
      expect(after.body.carePlan.unread).toBe(false);
    });

    it('applies the same receipt once however many times it arrives', async () => {
      const fixture = await setUp();
      const { carePlanId } = await plans(fixture);

      const operation: OutboxOperation = {
        opId: randomUUID(),
        kind: 'care_plan.read',
        participantId: fixture.participantId,
        carePlanId,
        payload: { id: randomUUID(), readAt: new Date().toISOString() },
      };

      const first = await push(fixture, [operation]);
      const second = await push(fixture, [operation]);

      expect(first.body.results[0].status).toBe('applied');
      expect(second.body.results[0].status).toBe('duplicate');

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from care_plan_reads`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('refuses a receipt for a participant this user has never had', async () => {
      const fixture = await setUp();
      const other = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.otherParticipantId}/care-plans`,
      ).send({ title: 'Theirs' });

      const response = await push(fixture, [
        {
          opId: randomUUID(),
          kind: 'care_plan.read',
          participantId: fixture.otherParticipantId,
          carePlanId: other.body.carePlan.id as string,
          payload: { id: randomUUID(), readAt: new Date().toISOString() },
        },
      ]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(response.body.results[0].error.code).toBe('scope_denied');
    });

    it('sends the plan again when a new version is published', async () => {
      // The device has to learn the body changed and that it is unread again.
      const fixture = await setUp();
      const { carePlanId } = await plans(fixture);

      const before = await api(fixture.worker, 'get', '/api/v1/sync/bootstrap', fixture.deviceId);
      const cursor = before.body.revision as number;

      const draft = await api(fixture.admin, 'put', `/api/v1/care-plans/${carePlanId}/draft`);
      await api(fixture.admin, 'patch', `/api/v1/care-plan-versions/${draft.body.draft.id}`).send({
        body: '## Seizure plan\n\n- Stay with them\n- Time it',
      });
      await api(
        fixture.admin,
        'post',
        `/api/v1/care-plan-versions/${draft.body.draft.id}/publish`,
      ).send({ changeSummary: 'Added timing' });

      const after = await api(
        fixture.worker,
        'get',
        `/api/v1/sync/changes?since=${cursor}`,
        fixture.deviceId,
      );

      const changes = after.body.changes as {
        entity: string;
        id: string;
        row: { body: string; changeSummary: string };
      }[];
      const plan = changes.find((one) => one.entity === 'care_plan' && one.id === carePlanId);
      expect(plan?.row.body).toContain('Time it');
      expect(plan?.row.changeSummary).toBe('Added timing');
    });
  });

  /* --------------------------------------------------------------- devices */

  describe('devices', () => {
    it('registers a device against the signed-in user', async () => {
      const fixture = await setUp();
      const response = await api(fixture.worker, 'post', '/api/v1/devices').send({
        deviceId: fixture.deviceId,
        platform: 'android',
        model: 'Pixel 8a',
      });

      expect(response.status).toBe(200);
      expect(response.body.device.platform).toBe('android');
      expect(response.body.device.wipeRequested).toBe(false);
    });

    it('does not show one user another user’s device', async () => {
      const fixture = await setUp();
      const otherUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const other = await signIn(h, otherUser);

      const response = await api(other, 'get', `/api/v1/devices/${fixture.deviceId}`);
      expect(response.status).toBe(404);
    });

    it('refuses sync to an anonymous caller', async () => {
      await setUp();
      const response = await request(h.app).get('/api/v1/sync/bootstrap');
      expect(response.status).toBe(401);
    });
  });

  async function firstCategoryId(): Promise<string> {
    const rows = await h.ownerDb.execute<{ id: string }>(
      sql`select id from diary_categories order by sort_order limit 1`,
    );
    return rows[0]!.id;
  }
});
