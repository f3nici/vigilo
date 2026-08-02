import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { addDays, localDateOf } from '@vigilo/shared';
import {
  assign,
  auditActions,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  TEST_PASSWORD,
  VENT_SCHEMA,
  type Harness,
  type SeededUser,
  type SignedIn,
} from './helpers.js';
import { materialiseParticipant } from '../src/services/windows.js';
import { selfAccessMayReach } from '../src/middleware/principal.js';

const MELBOURNE = 'Australia/Melbourne';

/**
 * Participant self-access end to end (doc 01 §3.5, doc 06 §6).
 *
 * Two things are being tested and they pull in opposite directions. The first
 * is that a person can read their own record, which is a right rather than a
 * feature. The second is that they can read nothing else, including the parts
 * of their own record staff decided not to show them.
 *
 * Most of this file is the second one, because that is the half that fails
 * silently. A screen that does not load is noticed the same day; a screen that
 * loads and shows one hidden note is noticed by nobody.
 */
describe('participant self-access', () => {
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
    me: SignedIn;
    selfUser: SeededUser;
    participantId: string;
    otherParticipantId: string;
    categoryId: string;
    versionId: string;
  };

  /**
   * One participant with a self-access account, one worker who writes about
   * them, and a second participant nobody in this fixture may see.
   */
  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const participantId = await seedParticipant(h.ownerDb, h.keyRing, {
      firstName: 'Aroha',
      lastName: 'Smith',
    });
    const otherParticipantId = await seedParticipant(h.ownerDb, h.keyRing, {
      firstName: 'Jae',
      lastName: 'Nguyen',
    });

    const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, workerUser.id, participantId);
    const worker = await signIn(h, workerUser);

    const selfUser = await seedUser(h.ownerDb, h.keyRing, {
      role: 'participant',
      participantId,
    });
    const me = await signIn(h, selfUser);

    const template = await api(admin, 'post', '/api/v1/check-templates').send({
      name: 'Morning check',
    });
    const versionId = template.body.template.draftVersion.id as string;
    await api(admin, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
      schema: VENT_SCHEMA,
    });
    await api(admin, 'post', `/api/v1/check-template-versions/${versionId}/publish`).send({});

    const categories = await api(admin, 'get', '/api/v1/diary-categories');
    const personalCare = (categories.body.categories as { id: string; slug: string }[]).find(
      (one) => one.slug === 'personal_care',
    );

    return {
      admin,
      worker,
      me,
      selfUser,
      participantId,
      otherParticipantId,
      categoryId: personalCare!.id,
      versionId,
    };
  }

  /** Hourly windows for today, so there is something to record against. */
  async function schedule(fixture: Fixture): Promise<string> {
    const created = await api(
      fixture.admin,
      'post',
      `/api/v1/participants/${fixture.participantId}/schedules`,
    ).send({
      templateId: (await api(fixture.admin, 'get', '/api/v1/check-templates')).body.templates[0]
        .id as string,
      name: 'Hourly observations',
      activeFrom: addDays(today(), -1),
      segments: [
        {
          label: 'All day',
          windowMinutes: 60,
          anchorTime: '00:00',
          appliesFromTime: '00:00',
          appliesToTime: '24:00',
        },
      ],
    });
    expect(created.status).toBe(201);

    await materialiseParticipant(h.db, fixture.participantId, today(), today());

    const windows = await api(
      fixture.admin,
      'get',
      `/api/v1/participants/${fixture.participantId}/windows`,
    );
    const open = (windows.body.windows as { id: string; endsAt: string }[]).find(
      (one) => new Date(one.endsAt) > new Date(),
    );
    expect(open).toBeDefined();
    return open!.id;
  }

  /** A complete check, recorded by the worker who is actually there. */
  async function recordCheck(fixture: Fixture, windowId: string): Promise<void> {
    const response = await api(fixture.worker, 'put', `/api/v1/windows/${windowId}/entry`).send({
      entryId: randomUUID(),
      templateVersionId: fixture.versionId,
      recordedAt: new Date().toISOString(),
      values: [
        { fieldKey: 'urine_output', number: 350 },
        { fieldKey: 'vent_mode', json: 'cpap' },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.window.status).toBe('complete');
  }

  async function writeDiary(
    fixture: Fixture,
    body: string,
    visibleToParticipant: boolean,
  ): Promise<string> {
    const response = await api(
      fixture.worker,
      'post',
      `/api/v1/participants/${fixture.participantId}/diary`,
    ).send({
      id: randomUUID(),
      categoryId: fixture.categoryId,
      body,
      occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      visibleToParticipant,
    });
    expect(response.status).toBe(201);
    return response.body.entry.id as string;
  }

  /* ------------------------------------------------------------- reading */

  describe('my day', () => {
    it('shows the checks that were recorded and who recorded them', async () => {
      const fixture = await setUp();
      const windowId = await schedule(fixture);
      await recordCheck(fixture, windowId);

      const response = await api(fixture.me, 'get', '/api/v1/me/day');

      expect(response.status).toBe(200);
      expect(response.body.day.checks).toHaveLength(1);
      expect(response.body.day.checks[0]).toMatchObject({
        templateName: 'Morning check',
        recordedByName: 'Test worker',
      });
      expect(response.body.day.checks[0].values).toEqual([
        { fieldKey: 'urine_output', label: 'Urine output', display: '350 ml' },
        { fieldKey: 'vent_mode', label: 'Ventilator mode', display: 'CPAP' },
      ]);
    });

    it('never shows a check nobody recorded', async () => {
      const fixture = await setUp();
      const windowId = await schedule(fixture);
      await recordCheck(fixture, windowId);

      // Every other window today is pending, and one of them is now missed.
      await h.ownerDb.execute(sql`
        update check_windows set status = 'missed'
        where participant_id = ${fixture.participantId}::uuid and status = 'pending'
      `);

      const response = await api(fixture.me, 'get', '/api/v1/me/day');

      // Doc 06 §6: missed checks concern staff performance, not the person.
      expect(response.body.day.checks).toHaveLength(1);
      expect(JSON.stringify(response.body)).not.toContain('missed');
      expect(JSON.stringify(response.body)).not.toContain('pending');
    });

    it('shows a visible diary entry and never a hidden one', async () => {
      const fixture = await setUp();
      await writeDiary(fixture, 'Went to the market and bought tomatoes.', true);
      await writeDiary(fixture, 'Staff concern raised with the team leader.', false);

      const response = await api(fixture.me, 'get', '/api/v1/me/day');

      expect(response.body.day.diary).toHaveLength(1);
      expect(response.body.day.diary[0].body).toContain('tomatoes');
      expect(JSON.stringify(response.body)).not.toContain('Staff concern');
    });

    it('carries no clinical identifiers and no staff detail beyond a name', async () => {
      const fixture = await setUp();
      const windowId = await schedule(fixture);
      await recordCheck(fixture, windowId);
      await writeDiary(fixture, 'A good afternoon.', true);

      const response = await api(fixture.me, 'get', '/api/v1/me/day');
      const payload = JSON.stringify(response.body);

      // The NDIS number and the date of birth are on the staff DTO for this
      // same participant. They are not on this one.
      expect(payload).not.toMatch(/ndis/i);
      expect(payload).not.toMatch(/dateOfBirth/i);
      // Nor is anything about whether the team kept to the schedule.
      expect(payload).not.toMatch(/isLate|compliance|expected|editCount/i);
    });

    it('says plainly when nothing was written down', async () => {
      const fixture = await setUp();

      const response = await api(fixture.me, 'get', `/api/v1/me/day?date=${addDays(today(), -2)}`);

      expect(response.status).toBe(200);
      expect(response.body.day.checks).toEqual([]);
      expect(response.body.day.diary).toEqual([]);
      expect(response.body.today).toBe(today());
    });

    it('refuses a participant id in the query string outright', async () => {
      const fixture = await setUp();

      // The schema is strict, so this is a parse failure rather than something
      // the service has to remember to ignore.
      const response = await api(
        fixture.me,
        'get',
        `/api/v1/me/day?participantId=${fixture.otherParticipantId}`,
      );

      expect(response.status).toBe(422);
    });
  });

  describe('my records', () => {
    it('returns a day for every date in the range, including empty ones', async () => {
      const fixture = await setUp();
      await writeDiary(fixture, 'Quiet morning.', true);

      const response = await api(
        fixture.me,
        'get',
        `/api/v1/me/records?from=${addDays(today(), -3)}&to=${today()}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.records.days).toHaveLength(4);
      expect(response.body.records.days.at(-1).diary).toHaveLength(1);
      expect(response.body.records.days[0].diary).toEqual([]);
      expect(response.body.records.participantName).toBe('Aroha Smith');
    });

    it('refuses a range longer than a month rather than timing out', async () => {
      const fixture = await setUp();

      const response = await api(
        fixture.me,
        'get',
        `/api/v1/me/records?from=${addDays(today(), -90)}&to=${today()}`,
      );

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('31 days');
    });
  });

  describe('my reports', () => {
    it('streams a PDF of the same record', async () => {
      const fixture = await setUp();
      await writeDiary(fixture, 'Went to the market.', true);

      const response = await api(
        fixture.me,
        'get',
        `/api/v1/me/reports/daily.pdf?from=${today()}&to=${today()}`,
      ).buffer(true);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain(`my-record-${today()}.pdf`);
      expect(response.body.length).toBeGreaterThan(500);
      expect(response.body.subarray(0, 4).toString()).toBe('%PDF');
    });
  });

  /* -------------------------------------------------------------- refusals */

  describe('what a self-access account cannot reach', () => {
    /**
     * The list matters more than any single entry on it. A participant is in
     * scope for their own record, so every one of these would otherwise have
     * answered with a staff DTO about them.
     */
    const forbidden = (fixture: Fixture): string[] => [
      '/api/v1/participants',
      `/api/v1/participants/${fixture.participantId}`,
      `/api/v1/participants/${fixture.participantId}/windows`,
      `/api/v1/participants/${fixture.participantId}/diary`,
      `/api/v1/participants/${fixture.participantId}/timeline`,
      `/api/v1/participants/${fixture.participantId}/care-plans`,
      `/api/v1/participants/${fixture.participantId}/medications`,
      `/api/v1/participants/${fixture.participantId}/incidents`,
      '/api/v1/me/windows/due',
      '/api/v1/me/doses/due',
      '/api/v1/me/incidents',
      '/api/v1/check-templates',
      '/api/v1/diary-categories',
      '/api/v1/users',
      '/api/v1/missed-reason-codes',
      `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${today()}`,
      '/api/v1/exports/checks.csv?from=2026-01-01&to=2026-01-02',
      '/api/v1/sync/bootstrap',
      '/api/v1/sync/changes?since=0',
      '/api/v1/audit-log',
    ];

    it('refuses every staff surface, including the ones about them', async () => {
      const fixture = await setUp();

      for (const path of forbidden(fixture)) {
        const response = await api(fixture.me, 'get', path);
        expect({ path, status: response.status }, `${path} should be refused`).toEqual({
          path,
          status: 403,
        });
      }
    });

    it('keeps records off the device entirely', async () => {
      const fixture = await setUp();

      // The sync feed is scoped by participant and not by field, so a device
      // pull would carry the hidden diary entry as a whole row.
      await writeDiary(fixture, 'Staff concern raised.', false);

      const bootstrap = await api(fixture.me, 'get', '/api/v1/sync/bootstrap');
      expect(bootstrap.status).toBe(403);

      const push = await api(fixture.me, 'post', '/api/v1/sync/push').send({ operations: [] });
      expect(push.status).toBe(403);
    });

    it('cannot write anything at all', async () => {
      const fixture = await setUp();

      const diary = await api(
        fixture.me,
        'post',
        `/api/v1/participants/${fixture.participantId}/diary`,
      ).send({
        id: randomUUID(),
        categoryId: fixture.categoryId,
        body: 'Written by the participant.',
        occurredAt: new Date().toISOString(),
      });
      expect(diary.status).toBe(403);
    });

    it('lets staff keep using everything on that list', async () => {
      const fixture = await setUp();

      // The guard is about the role, not about the paths, and a regression
      // that locked staff out would otherwise look like a passing test file.
      for (const path of [
        `/api/v1/participants/${fixture.participantId}`,
        `/api/v1/participants/${fixture.participantId}/diary`,
        '/api/v1/me/windows/due',
        '/api/v1/sync/bootstrap',
      ]) {
        const response = await api(fixture.worker, 'get', path);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
      }
    });

    it('still lets them change their own password and sign out', async () => {
      const fixture = await setUp();

      const me = await api(fixture.me, 'get', '/api/v1/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.principal.role).toBe('participant');

      const logout = await api(fixture.me, 'post', '/api/v1/auth/logout').send({});
      expect(logout.status).toBe(204);

      // An account that cannot change its own password is an account somebody
      // else has to keep holding a credential for.
      const back = await signIn(h, fixture.selfUser);
      const password = await api(back, 'post', '/api/v1/auth/password').send({
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-different-long-enough-passphrase',
      });
      expect(password.status).toBe(204);
    });
  });

  /**
   * The allow-list on its own, without a database in the way.
   *
   * The integration tests above check the paths that exist today. These check
   * the shape of the rule, which is what has to hold when somebody adds a
   * route next phase.
   */
  describe('the allow-list', () => {
    const ATTACHMENT = '/attachments/01952d3f-0000-7000-8000-000000000001';

    it('allows exactly the paths doc 06 §6 describes', () => {
      expect(selfAccessMayReach('GET', '/me/day')).toBe(true);
      expect(selfAccessMayReach('GET', '/me/records')).toBe(true);
      expect(selfAccessMayReach('GET', '/me/reports/daily.pdf')).toBe(true);
      expect(selfAccessMayReach('POST', '/auth/logout')).toBe(true);
    });

    it('refuses by default, which is the point of writing it this way', () => {
      for (const path of [
        '/participants',
        '/me/windows/due',
        '/me/incidents',
        '/me/notification-preferences',
        '/sync/bootstrap',
        '/reports/daily',
        // The route a later phase has not written yet.
        '/goals/whatever-comes-next',
      ]) {
        expect(selfAccessMayReach('GET', path), path).toBe(false);
      }
    });

    it('treats a trailing slash the way Express routes it', () => {
      expect(selfAccessMayReach('GET', '/me/day/')).toBe(true);
    });

    it('does not let a prefix match open a longer path', () => {
      expect(selfAccessMayReach('GET', '/me/day/everything')).toBe(false);
      expect(selfAccessMayReach('GET', '/me/records-and-more')).toBe(false);
    });

    it('allows reading a photo and never writing one', () => {
      expect(selfAccessMayReach('GET', ATTACHMENT)).toBe(true);
      expect(selfAccessMayReach('GET', `${ATTACHMENT}/thumb`)).toBe(true);
      // The DELETE shares the path with the GET, so the method matters.
      expect(selfAccessMayReach('DELETE', ATTACHMENT)).toBe(false);
      expect(selfAccessMayReach('PUT', `${ATTACHMENT}/content`)).toBe(false);
    });

    it('wants a real id, not a path that happens to start the same way', () => {
      expect(selfAccessMayReach('GET', '/attachments')).toBe(false);
      expect(selfAccessMayReach('GET', '/attachments/../participants')).toBe(false);
    });
  });

  /* ----------------------------------------------------------------- audit */

  describe('the audit log', () => {
    it('records the read, because a view of a record is a view', async () => {
      const fixture = await setUp();

      await api(fixture.me, 'get', '/api/v1/me/day');
      await api(fixture.me, 'get', `/api/v1/me/records?from=${today()}&to=${today()}`);
      await api(
        fixture.me,
        'get',
        `/api/v1/me/reports/daily.pdf?from=${today()}&to=${today()}`,
      ).buffer(true);

      const actions = await auditActions(h.ownerDb);
      expect(actions).toContain('self_access.day');
      expect(actions).toContain('self_access.records');
      expect(actions).toContain('self_access.pdf');
    });

    it('names the participant on the row, so a right-of-access request is answerable', async () => {
      const fixture = await setUp();
      await api(fixture.me, 'get', '/api/v1/me/day');

      const rows = await h.ownerDb.execute<{ participant_id: string }>(
        sql`select participant_id from audit_log where action = 'self_access.day'`,
      );
      expect(rows[0]?.participant_id).toBe(fixture.participantId);
    });
  });
});
