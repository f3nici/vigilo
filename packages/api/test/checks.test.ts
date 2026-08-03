import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { addDays, localDateOf, weekdayOf } from '@vigilo/shared';
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
import { closeWindows, materialiseParticipant } from '../src/services/windows.js';

const MELBOURNE = 'Australia/Melbourne';

/**
 * Schedules, windows and entries end to end (doc 01 §5, doc 04 §6 and §7).
 *
 * These run against real windows on a real grid rather than fixtures, because
 * the parts most likely to be wrong are the seams: local time to UTC, coverage
 * to expected, entry to window status.
 */
describe('checks', () => {
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

  /**
   * The next occurrence of a weekday, today included.
   *
   * Deliberately not a fixed date. A coverage pattern applies from the day it
   * is set (D38), so a preview of a date in the past sees no pattern at all
   * and every window comes back not-expected. A hard-coded date passes until
   * the clock rolls past it and then fails for a reason that has nothing to do
   * with coverage.
   */
  function nextWeekday(weekday: number): string {
    let date = today();
    for (let step = 0; step < 7; step += 1) {
      if (weekdayOf(date) === weekday) return date;
      date = addDays(date, 1);
    }
    throw new Error(`No ${weekday} in the next week, which cannot happen`);
  }

  type Fixture = {
    admin: SignedIn;
    adminId: string;
    participantId: string;
    templateId: string;
    versionId: string;
  };

  /** An admin, a participant and a published vent observation form. */
  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const participant = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Alice',
      lastName: 'Smith',
      dateOfBirth: '1994-03-02',
      ndisNumber: '431234567',
    });
    expect(participant.status).toBe(201);

    const template = await api(admin, 'post', '/api/v1/check-templates').send({
      name: 'Vent observations',
    });
    const templateId = template.body.template.id as string;
    const versionId = template.body.template.draftVersion.id as string;

    await api(admin, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
      schema: VENT_SCHEMA,
    });
    await api(admin, 'post', `/api/v1/check-template-versions/${versionId}/publish`).send({});

    return {
      admin,
      adminId: adminUser.id,
      participantId: participant.body.participant.id as string,
      templateId,
      versionId,
    };
  }

  /** 2-hourly through the day and 4-hourly overnight, the docs' example. */
  const DAY_AND_NIGHT = [
    {
      label: 'Daytime',
      windowMinutes: 120,
      anchorTime: '07:00',
      appliesFromTime: '07:00',
      appliesToTime: '21:00',
    },
    {
      label: 'Overnight',
      windowMinutes: 240,
      anchorTime: '21:00',
      appliesFromTime: '21:00',
      appliesToTime: '07:00',
      sortOrder: 1,
    },
  ];

  describe('the schedule preview', () => {
    it('shows the resulting window times before anything is saved', async () => {
      const { admin, participantId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({ date: nextWeekday(1), segments: DAY_AND_NIGHT });

      expect(response.status).toBe(200);
      expect(response.body.timeZone).toBe(MELBOURNE);
      expect(
        (response.body.windows as { startMinutes: number; endMinutes: number }[]).map(
          (one) => `${one.startMinutes}-${one.endMinutes}`,
        ),
      ).toEqual([
        '420-540',
        '540-660',
        '660-780',
        '780-900',
        '900-1020',
        '1020-1140',
        '1140-1260',
        '1260-1500',
        '1500-1740',
        '1740-1860',
      ]);

      // Nothing was written.
      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      expect(windows.body.windows).toEqual([]);
    });

    it('warns about the uneven final overnight window without blocking it', async () => {
      const { admin, participantId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({ date: nextWeekday(1), segments: DAY_AND_NIGHT });

      const codes = (response.body.warnings as { code: string }[]).map((one) => one.code);
      expect(codes).toContain('uneven_division');
      expect(response.body.problems).toEqual([]);
    });

    it('refuses overlapping segments outright', async () => {
      const { admin, participantId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({
        date: '2026-07-27',
        segments: [
          {
            windowMinutes: 120,
            anchorTime: '07:00',
            appliesFromTime: '07:00',
            appliesToTime: '15:00',
          },
          {
            windowMinutes: 120,
            anchorTime: '13:00',
            appliesFromTime: '13:00',
            appliesToTime: '21:00',
          },
        ],
      });

      expect(response.body.problems).toHaveLength(1);
      expect(response.body.problems[0].code).toBe('overlap');
      expect(response.body.windows).toEqual([]);
    });

    it('greys out the windows coverage says nobody is there for', async () => {
      const { admin, participantId } = await setUp();

      // Weekdays only, 07:00 to 19:00.
      await api(admin, 'put', `/api/v1/participants/${participantId}/coverage-pattern`).send({
        ranges: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startTime: '07:00',
          endTime: '19:00',
        })),
      });

      const sunday = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({ date: nextWeekday(0), segments: DAY_AND_NIGHT });

      expect((sunday.body.windows as { expected: boolean }[]).every((one) => !one.expected)).toBe(
        true,
      );
      expect(sunday.body.windows[0].coverageReason).toBe('Outside supported hours');

      const monday = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({ date: nextWeekday(1), segments: DAY_AND_NIGHT });

      const expected = (monday.body.windows as { expected: boolean }[]).filter(
        (one) => one.expected,
      );
      // Support runs 07:00 to 19:00, so the six daytime windows up to 19:00.
      // The 19:00-21:00 one starts exactly as support ends, and ranges are
      // half-open, so nobody is there for any part of it.
      expect(expected).toHaveLength(6);
    });
  });

  describe('creating a schedule', () => {
    it('lays the grid straight away rather than waiting for the job', async () => {
      const { admin, participantId, templateId } = await setUp();

      const created = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules`,
      ).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      expect(created.status).toBe(201);
      expect(created.body.schedule.segments).toHaveLength(2);

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      expect(windows.body.windows.length).toBeGreaterThan(0);
      expect(windows.body.windows[0].scheduleName).toBe('Vent observations');
      expect(windows.body.windows[0].templateName).toBe('Vent observations');
    });

    it('refuses a schedule against a form that was never published', async () => {
      const { admin, participantId } = await setUp();

      const unpublished = await api(admin, 'post', '/api/v1/check-templates').send({
        name: 'Weight check',
      });

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules`,
      ).send({
        templateId: unpublished.body.template.id,
        name: 'Weight',
        activeFrom: today(),
        segments: [
          {
            windowMinutes: 1440,
            anchorTime: '09:00',
            appliesFromTime: '09:00',
            appliesToTime: '10:00',
          },
        ],
      });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('has not been published');
    });

    /*
     * D85, and the same rule doses have had since D59. Before this, a schedule
     * saved in the afternoon produced a morning of windows nobody could have
     * recorded, and the closer marked every one of them missed within the hour.
     */
    it('never lays a window that has already closed', async () => {
      const { admin, participantId, templateId } = await setUp();

      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const closed = windows.body.windows.filter(
        (window: { endsAt: string }) => new Date(window.endsAt) <= new Date(),
      );

      expect(closed).toEqual([]);
      expect(windows.body.windows.length).toBeGreaterThan(0);
    });

    it('still lays the window that is open right now', async () => {
      // A worker is standing there and can record it. Skipping it would lose a
      // check that could genuinely be done.
      const { participantId, templateId, admin } = await setUp();

      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Round the clock',
        activeFrom: today(),
        segments: [
          {
            label: 'All day',
            windowMinutes: 120,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '00:00',
          },
        ],
      });

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const now = Date.now();
      const open = windows.body.windows.filter(
        (window: { startsAt: string; endsAt: string }) =>
          new Date(window.startsAt).getTime() <= now && new Date(window.endsAt).getTime() > now,
      );

      expect(open).toHaveLength(1);
    });

    it('counts what it skipped, so a job run says so rather than looking empty', async () => {
      const { participantId, templateId, admin } = await setUp();
      /*
       * Three days back, not yesterday. `DAY_AND_NIGHT` has an overnight
       * segment running to 07:00, so yesterday's grid is still partly open
       * when the suite runs just after midnight, and three of its windows are
       * correctly created. Same trap the lateness tests already document.
       */
      const wellPast = addDays(today(), -3);

      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: wellPast,
        segments: DAY_AND_NIGHT,
      });

      // A day wholly in the past: everything is skipped and nothing is
      // created, and the two numbers say which of those happened.
      const result = await materialiseParticipant(h.db, participantId, wellPast, wellPast);

      expect(result.created).toBe(0);
      expect(result.skippedAlreadyClosed).toBeGreaterThan(0);
    });

    it('is idempotent, so the materialiser never doubles the grid', async () => {
      const { admin, participantId, templateId } = await setUp();

      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const first = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const again = await materialiseParticipant(h.db, participantId, today(), addDays(today(), 7));
      const second = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);

      expect(again.created).toBe(0);
      expect(second.body.windows).toHaveLength(first.body.windows.length);
    });
  });

  /* ------------------------------------------- checks nobody scheduled */

  describe('recording a check on demand', () => {
    /**
     * D89. Until this existed, the only way to record anything was for an
     * admin to have scheduled it first, so a worker asked to take a blood
     * pressure had nowhere to put it.
     */
    function goodValues() {
      return [
        { fieldKey: 'urine_output', number: 350 },
        { fieldKey: 'vent_mode', json: 'cpap' },
      ];
    }

    /** D94. A form is only offered for somebody it was ticked for. */
    async function tick(
      admin: Awaited<ReturnType<typeof signIn>>,
      participantId: string,
      templateIds: string[],
    ) {
      const response = await api(admin, 'put', `/api/v1/participants/${participantId}/forms`).send({
        templateIds,
      });
      expect(response.status).toBe(200);
      return response;
    }

    it('lists the published forms a worker can fill in', async () => {
      const { admin, participantId, templateId } = await setUp();
      await tick(admin, participantId, [templateId]);

      const response = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/recordable-forms`,
      );

      expect(response.status).toBe(200);
      expect(response.body.forms).toHaveLength(1);
      // A name and an id, not the admin template list: draft state, version
      // counts and schedule counts are about managing forms, not using one.
      expect(Object.keys(response.body.forms[0]).sort()).toEqual(['description', 'id', 'name']);
    });

    it('leaves out a form that was never published', async () => {
      const { admin, participantId, templateId } = await setUp();
      const draft = await api(admin, 'post', '/api/v1/check-templates').send({
        name: 'Weight check',
      });
      await tick(admin, participantId, [templateId, draft.body.template.id as string]);

      const response = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/recordable-forms`,
      );
      expect(response.body.forms.map((form: { name: string }) => form.name)).toEqual([
        'Vent observations',
      ]);
    });

    /**
     * The whole point of D94: a published form belonging to somebody else is
     * not on this person's picker. This is the assertion that would have
     * caught the old behaviour, where every form in the org was offered for
     * every participant.
     */
    it('leaves out a published form that was never ticked for this person', async () => {
      const { admin, participantId } = await setUp();

      const response = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/recordable-forms`,
      );

      expect(response.status).toBe(200);
      expect(response.body.forms).toEqual([]);
    });

    /**
     * A form on this participant's schedule is theirs by a stronger route than
     * a tick. Leaving it out would mean a worker could fill in a window for a
     * form they cannot record on demand.
     */
    it('includes a form that is on the schedule without being ticked', async () => {
      const { admin, participantId, templateId } = await setUp();
      const schedule = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules`,
      ).send({
        templateId,
        name: 'Vent obs',
        activeFrom: '2026-01-01',
        segments: DAY_AND_NIGHT,
      });
      expect(schedule.status).toBe(201);

      const response = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/recordable-forms`,
      );
      expect(response.body.forms.map((form: { name: string }) => form.name)).toEqual([
        'Vent observations',
      ]);
    });

    it('gives an admin the tick list, and saves it', async () => {
      const { admin, participantId, templateId } = await setUp();

      const before = await api(admin, 'get', `/api/v1/participants/${participantId}/form-choices`);
      expect(before.status).toBe(200);
      expect(before.body.forms).toEqual([
        expect.objectContaining({ id: templateId, assigned: false, recordable: true }),
      ]);

      const saved = await tick(admin, participantId, [templateId]);
      expect(saved.body.forms).toEqual([
        expect.objectContaining({ id: templateId, assigned: true }),
      ]);

      // Saving the empty set takes them all off again, rather than being a no-op.
      const cleared = await tick(admin, participantId, []);
      expect(cleared.body.forms).toEqual([
        expect.objectContaining({ id: templateId, assigned: false }),
      ]);
    });

    it('refuses the tick list to a worker', async () => {
      const { admin, participantId, templateId } = await setUp();
      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const worker = await signIn(h, workerUser);
      await api(admin, 'post', `/api/v1/participants/${participantId}/assignments`).send({
        userId: workerUser.id,
        kind: 'standing',
      });

      const listed = await api(worker, 'get', `/api/v1/participants/${participantId}/form-choices`);
      expect(listed.status).toBe(403);

      const saved = await api(worker, 'put', `/api/v1/participants/${participantId}/forms`).send({
        templateIds: [templateId],
      });
      expect(saved.status).toBe(403);
    });

    it('records one with no window at all', async () => {
      const { admin, participantId, templateId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date().toISOString(),
        values: goodValues(),
      });

      expect(response.status).toBe(201);
      expect(response.body.entry.windowId).toBeNull();
      expect(response.body.entry.status).toBe('complete');
      // Nothing asked for it, so there is nothing for it to be late for.
      expect(response.body.entry.isLate).toBe(false);
    });

    it('binds it to the published version, whatever the device thought', async () => {
      const { admin, participantId, templateId, versionId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date().toISOString(),
        values: goodValues(),
      });

      expect(response.body.entry.templateVersionId).toBe(versionId);
    });

    it('is idempotent, so a replayed outbox row does not record it twice', async () => {
      const { admin, participantId, templateId } = await setUp();
      const entryId = randomUUID();
      const body = {
        entryId,
        templateId,
        recordedAt: new Date().toISOString(),
        values: goodValues(),
      };

      await api(admin, 'post', `/api/v1/participants/${participantId}/checks`).send(body);
      const again = await api(admin, 'post', `/api/v1/participants/${participantId}/checks`).send(
        body,
      );

      expect(again.status).toBe(201);
      expect(again.body.entry.id).toBe(entryId);

      const [{ count }] = await h.ownerDb.execute(
        sql`select count(*)::int as count from check_entries where window_id is null`,
      );
      expect(count).toBe(1);
    });

    it('refuses a form that has never been published', async () => {
      const { admin, participantId } = await setUp();
      const unpublished = await api(admin, 'post', '/api/v1/check-templates').send({
        name: 'Weight check',
      });

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId: unpublished.body.template.id,
        recordedAt: new Date().toISOString(),
        values: [],
      });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('not been published');
    });

    it('refuses a time that has not happened yet', async () => {
      // A check recorded in the future would sit at the top of a day that has
      // not happened.
      const { admin, participantId, templateId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date(Date.now() + 3_600_000).toISOString(),
        values: goodValues(),
      });

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('has not happened yet');
    });

    it('validates values exactly as a scheduled check does', async () => {
      const { admin, participantId, templateId } = await setUp();

      const response = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 9000 }],
      });

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('cannot be above');
    });

    it('needs a team leader to write one up from days ago', async () => {
      const { admin, participantId, templateId } = await setUp();
      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
      const body = {
        entryId: randomUUID(),
        templateId,
        recordedAt: threeDaysAgo,
        values: goodValues(),
      };

      const refused = await api(
        worker,
        'post',
        `/api/v1/participants/${participantId}/checks`,
      ).send(body);
      expect(refused.status).toBe(409);

      // The same record, by somebody who may back-fill.
      const allowed = await api(admin, 'post', `/api/v1/participants/${participantId}/checks`).send(
        {
          ...body,
          entryId: randomUUID(),
        },
      );
      expect(allowed.status).toBe(201);
    });

    it('keeps it out of the compliance percentage, and counts it beside', async () => {
      /*
       * The number somebody will be asked to defend. Counting these as
       * completed would either push it above 100% or hide a missed scheduled
       * check behind an unscheduled one.
       */
      const fixture = await setUp();
      const { admin, participantId, templateId } = fixture;

      for (let i = 0; i < 3; i += 1) {
        await api(admin, 'post', `/api/v1/participants/${participantId}/checks`).send({
          entryId: randomUUID(),
          templateId,
          recordedAt: new Date().toISOString(),
          values: goodValues(),
        });
      }

      const report = await api(
        admin,
        'get',
        `/api/v1/reports/compliance?from=${today()}&to=${today()}`,
      );

      expect(report.body.report.total.unscheduled).toBe(3);
      expect(report.body.report.total.expected).toBe(0);
      expect(report.body.report.total.completed).toBe(0);
      expect(report.body.report.totalPercent).toBeNull();
    });

    it('shows on the daily report, under its own heading', async () => {
      const { admin, participantId, templateId } = await setUp();

      await api(admin, 'post', `/api/v1/participants/${participantId}/checks`).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date().toISOString(),
        values: goodValues(),
      });

      const report = await api(
        admin,
        'get',
        `/api/v1/reports/daily?participantId=${participantId}&date=${today()}`,
      );

      const day = report.body.report.days[0];
      expect(day.unscheduled).toHaveLength(1);
      expect(day.unscheduled[0].templateName).toBe('Vent observations');
      // Rendered through the same formatter a scheduled check uses, so the
      // same reading never reads differently depending on who asked for it.
      expect(day.unscheduled[0].values).toContainEqual({
        fieldKey: 'urine_output',
        label: 'Urine output',
        display: '350 ml',
      });
      // And never in the windows array, which is what compliance counts.
      expect(day.windows.every((one: { id: string }) => one.id !== day.unscheduled[0].id)).toBe(
        true,
      );
    });

    it('refuses a self-access account outright', async () => {
      const { participantId, templateId } = await setUp();
      const selfUser = await seedUser(h.ownerDb, h.keyRing, { role: 'participant', participantId });
      const self = await signIn(h, selfUser);

      const response = await api(self, 'post', `/api/v1/participants/${participantId}/checks`).send(
        {
          entryId: randomUUID(),
          templateId,
          recordedAt: new Date().toISOString(),
          values: goodValues(),
        },
      );

      expect(response.status).toBe(403);
    });

    it('refuses a participant somebody is not assigned to', async () => {
      const { admin, templateId } = await setUp();
      const other = await api(admin, 'post', '/api/v1/participants').send({
        firstName: 'Bob',
        lastName: 'Jones',
        dateOfBirth: '1990-01-01',
        ndisNumber: '431234568',
      });

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const worker = await signIn(h, workerUser);

      const response = await api(
        worker,
        'post',
        `/api/v1/participants/${other.body.participant.id}/checks`,
      ).send({
        entryId: randomUUID(),
        templateId,
        recordedAt: new Date().toISOString(),
        values: goodValues(),
      });

      expect(response.status).toBe(403);
    });
  });

  describe('changing a schedule', () => {
    async function scheduled(): Promise<Fixture & { scheduleId: string }> {
      const fixture = await setUp();
      const created = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/schedules`,
      ).send({
        templateId: fixture.templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });
      return { ...fixture, scheduleId: created.body.schedule.id as string };
    }

    it('regenerates future windows when the segments change', async () => {
      const { admin, scheduleId, participantId } = await scheduled();

      const response = await api(admin, 'put', `/api/v1/schedules/${scheduleId}/segments`).send({
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body.regenerated.removed).toBeGreaterThan(0);
      expect(response.body.regenerated.created).toBeGreaterThan(0);

      // Two days out, so no window still in progress reaches into the day
      // being counted and the grid is purely the new one.
      const day = addDays(today(), 2);
      const windows = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/windows?from=${day}&to=${day}`,
      );
      // Hourly for a whole day.
      expect(windows.body.windows).toHaveLength(24);
    });

    /** Doc 01 §5.3: the entry keeps its original window. */
    it('never destroys a window that already holds an entry', async () => {
      const { admin, scheduleId, participantId, versionId } = await scheduled();

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const open = (windows.body.windows as { id: string; status: string; endsAt: string }[]).find(
        (one) => new Date(one.endsAt) > new Date(),
      );
      expect(open).toBeDefined();

      await api(admin, 'put', `/api/v1/windows/${open!.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      const changed = await api(admin, 'put', `/api/v1/schedules/${scheduleId}/segments`).send({
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      expect(changed.body.regenerated.preserved).toBeGreaterThan(0);

      const after = await api(admin, 'get', `/api/v1/windows/${open!.id}`);
      expect(after.status).toBe(200);
      expect(after.body.window.entryId).not.toBeNull();
    });

    it('reports what a change would disturb before it is made', async () => {
      const { admin, scheduleId, participantId, versionId } = await scheduled();

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const open = (windows.body.windows as { id: string; endsAt: string }[]).find(
        (one) => new Date(one.endsAt) > new Date(),
      )!;

      await api(admin, 'put', `/api/v1/windows/${open.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      const preview = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview?scheduleId=${scheduleId}`,
      ).send({
        date: today(),
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      expect(preview.body.entriesAffected).toBe(1);
      expect(preview.body.windowsToRegenerate).toBeGreaterThan(0);
      expect((preview.body.warnings as { code: string }[]).map((one) => one.code)).toContain(
        'entries_affected',
      );
    });
  });

  describe('recording a check', () => {
    async function openWindow(): Promise<Fixture & { windowId: string }> {
      const fixture = await setUp();
      await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/schedules`,
      ).send({
        templateId: fixture.templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      const windows = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/windows`,
      );
      const open = (
        windows.body.windows as { id: string; endsAt: string; startsAt: string }[]
      ).find((one) => new Date(one.startsAt) <= new Date() && new Date(one.endsAt) > new Date());
      expect(open).toBeDefined();

      return { ...fixture, windowId: open!.id };
    }

    it('goes partial then complete as required fields are filled', async () => {
      const { admin, windowId, versionId } = await openWindow();
      const entryId = randomUUID();

      const partial = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId,
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      expect(partial.status).toBe(200);
      expect(partial.body.entry.status).toBe('partial');
      expect(partial.body.window.status).toBe('partial');
      expect(partial.body.window.filledRequiredCount).toBe(1);
      expect(partial.body.window.requiredFieldCount).toBe(2);

      const complete = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId,
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'vent_mode', json: 'bipap' }],
      });

      expect(complete.body.entry.status).toBe('complete');
      expect(complete.body.window.status).toBe('complete');
      // The first value is still there: a partial save adds, it does not replace.
      expect(complete.body.entry.values).toHaveLength(2);
    });

    it('says who filled the check in, on the window itself', async () => {
      const { admin, windowId, versionId, participantId } = await openWindow();

      await api(admin, 'put', `/api/v1/windows/${windowId}/entry`)
        .send({
          entryId: randomUUID(),
          templateVersionId: versionId,
          recordedAt: new Date().toISOString(),
          values: [{ fieldKey: 'urine_output', number: 350 }],
        })
        .expect(200);

      // On the window list, so a timeline row can name the person without
      // fetching every entry behind it.
      const windows = await api(
        admin,
        'get',
        `/api/v1/participants/${participantId}/windows`,
      ).expect(200);

      const recorded = (
        windows.body.windows as { id: string; recordedByName: string | null }[]
      ).find((one) => one.id === windowId);
      expect(recorded!.recordedByName).toBe('Test admin');

      const detail = await api(admin, 'get', `/api/v1/windows/${windowId}`).expect(200);
      expect(detail.body.window.recordedByName).toBe('Test admin');
      expect(detail.body.window.entry.recordedByName).toBe('Test admin');
    });

    it('leaves the recorder empty on a window nobody has touched', async () => {
      const { admin, windowId } = await openWindow();

      const detail = await api(admin, 'get', `/api/v1/windows/${windowId}`).expect(200);
      expect(detail.body.window.recordedByName).toBeNull();
    });

    it('updates the same row when the request is replayed', async () => {
      const { admin, windowId, versionId } = await openWindow();
      const entryId = randomUUID();
      const body = {
        entryId,
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      };

      await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send(body);
      const replay = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send(body);

      expect(replay.status).toBe(200);
      expect(replay.body.entry.id).toBe(entryId);

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from check_entries`,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it('keeps the number exact and stores the unit with it', async () => {
      const { admin, windowId, versionId } = await openWindow();

      await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      const rows = await h.ownerDb.execute<{ value_number: string; unit: string }>(
        sql`select value_number, unit from check_entry_values where field_key = 'urine_output'`,
      );
      expect(rows[0]!.value_number).toBe('350');
      expect(rows[0]!.unit).toBe('ml');
    });

    it('refuses a value outside the input bounds', async () => {
      const { admin, windowId, versionId } = await openWindow();

      const response = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 9000 }],
      });

      expect(response.status).toBe(422);
      expect(response.body.error.message).toContain('cannot be above');
    });

    it('refuses a submission against a superseded version rather than remapping it', async () => {
      const { admin, windowId, templateId } = await openWindow();

      const draft = await api(admin, 'post', `/api/v1/check-templates/${templateId}/versions`).send(
        {},
      );
      const draftId = draft.body.version.id as string;
      await api(admin, 'post', `/api/v1/check-template-versions/${draftId}/publish`).send({});

      const response = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: draftId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('template_version_mismatch');
    });

    it('encrypts free text at rest and leaves the number readable', async () => {
      const { admin, windowId, versionId } = await openWindow();

      await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 350 },
          { fieldKey: 'comment', text: 'Settled, no distress overnight.' },
        ],
      });

      const [row] = await h.ownerDb.execute<{ dump: string }>(
        sql`select check_entry_values::text as dump from check_entry_values where field_key = 'comment'`,
      );
      expect(row!.dump).not.toContain('Settled');
      expect(row!.dump).not.toContain('distress');

      // A8: the number stays plain so trends and compliance are plain SQL.
      const [numeric] = await h.ownerDb.execute<{ dump: string }>(
        sql`select check_entry_values::text as dump from check_entry_values where field_key = 'urine_output'`,
      );
      expect(numeric!.dump).toContain('350');

      // And it still reads back through the API.
      const window = await api(admin, 'get', `/api/v1/windows/${windowId}`);
      const comment = (
        window.body.window.entry.values as { fieldKey: string; text: string }[]
      ).find((one) => one.fieldKey === 'comment');
      expect(comment!.text).toBe('Settled, no distress overnight.');
    });
  });

  describe('late entries and missed windows', () => {
    /** A window that closed yesterday, so lateness is real rather than mocked. */
    async function closedWindow(): Promise<Fixture & { windowId: string; endsAt: string }> {
      const fixture = await setUp();
      // Three days back, not yesterday. The back-fill cut-off is 24 hours, and
      // "yesterday" is under an hour ago when the suite runs just after
      // midnight, which made this pass or fail on the time of day.
      const yesterday = addDays(today(), -3);

      await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/schedules`,
      ).send({
        templateId: fixture.templateId,
        name: 'Vent observations',
        activeFrom: yesterday,
        segments: [
          {
            windowMinutes: 120,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      /*
       * `now` set to the start of that day. The materialiser refuses to lay a
       * window that has already closed (D85), which is the point of D85, so a
       * test that needs a closed window has to say when it is pretending to be
       * rather than reach around the rule.
       */
      await materialiseParticipant(
        h.db,
        fixture.participantId,
        yesterday,
        yesterday,
        new Date(`${yesterday}T00:00:00Z`),
      );
      await closeWindows(h.db);

      const windows = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/windows?from=${yesterday}&to=${yesterday}`,
      );
      const closed = (
        windows.body.windows as { id: string; endsAt: string; status: string }[]
      ).find((one) => one.status === 'missed');
      expect(closed).toBeDefined();

      return { ...fixture, windowId: closed!.id, endsAt: closed!.endsAt };
    }

    it('marks a window missed once it closes unrecorded', async () => {
      const { admin, windowId } = await closedWindow();
      const response = await api(admin, 'get', `/api/v1/windows/${windowId}`);
      expect(response.body.window.status).toBe('missed');
      expect(response.body.window.missReason).toBeNull();
    });

    it('accepts a late entry and flags it as late', async () => {
      const { admin, windowId, versionId } = await closedWindow();

      const response = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 350 },
          { fieldKey: 'vent_mode', json: 'cpap' },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body.entry.isLate).toBe(true);
      // `missed` is not terminal: a late entry still completes the window.
      expect(response.body.window.status).toBe('complete');
      expect(response.body.window.isLate).toBe(true);
      expect(response.body.window.lateByMinutes).toBeGreaterThan(0);
    });

    it('needs a team leader to back-fill past the cut-off', async () => {
      const { admin, participantId, windowId, versionId } = await closedWindow();

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      // The default cut-off is 24 hours, and this window closed yesterday.
      const refused = await api(worker, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toContain('team leader');

      const allowed = await api(admin, 'put', `/api/v1/windows/${windowId}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });
      expect(allowed.status).toBe(200);
    });

    it('records a miss reason and resolves the prompt', async () => {
      const { admin, windowId } = await closedWindow();

      const codes = await api(admin, 'get', '/api/v1/missed-reason-codes');
      const asleep = (codes.body.reasonCodes as { id: string; code: string }[]).find(
        (one) => one.code === 'asleep',
      )!;

      const response = await api(admin, 'put', `/api/v1/windows/${windowId}/miss-reason`).send({
        reasonCodeId: asleep.id,
      });

      expect(response.status).toBe(200);
      expect(response.body.missReason.code).toBe('asleep');
      expect(response.body.window.missReason.label).toBe('Participant was asleep');
      // Still missed. A reason explains it, it does not undo it.
      expect(response.body.window.status).toBe('missed');
    });

    it('requires a note on a code configured to need one', async () => {
      const { admin, windowId } = await closedWindow();

      const codes = await api(admin, 'get', '/api/v1/missed-reason-codes');
      const other = (codes.body.reasonCodes as { id: string; code: string }[]).find(
        (one) => one.code === 'other',
      )!;

      const refused = await api(admin, 'put', `/api/v1/windows/${windowId}/miss-reason`).send({
        reasonCodeId: other.id,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toContain('needs a short note');

      const accepted = await api(admin, 'put', `/api/v1/windows/${windowId}/miss-reason`).send({
        reasonCodeId: other.id,
        note: 'Power was out and the monitor would not start.',
      });
      expect(accepted.status).toBe(200);
    });

    it('encrypts the miss reason note', async () => {
      const { admin, windowId } = await closedWindow();
      const codes = await api(admin, 'get', '/api/v1/missed-reason-codes');
      const other = (codes.body.reasonCodes as { id: string; code: string }[]).find(
        (one) => one.code === 'other',
      )!;

      await api(admin, 'put', `/api/v1/windows/${windowId}/miss-reason`).send({
        reasonCodeId: other.id,
        note: 'Alice was at her sister wedding.',
      });

      const [row] = await h.ownerDb.execute<{ dump: string }>(
        sql`select window_miss_reasons::text as dump from window_miss_reasons limit 1`,
      );
      expect(row!.dump).not.toContain('Alice');
      expect(row!.dump).not.toContain('wedding');
    });
  });

  describe('editing an entry', () => {
    async function recorded(): Promise<Fixture & { entryId: string; windowId: string }> {
      const fixture = await setUp();
      await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/schedules`,
      ).send({
        templateId: fixture.templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      const windows = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/windows`,
      );
      const open = (
        windows.body.windows as { id: string; startsAt: string; endsAt: string }[]
      ).find((one) => new Date(one.startsAt) <= new Date() && new Date(one.endsAt) > new Date())!;

      const entryId = randomUUID();
      await api(fixture.admin, 'put', `/api/v1/windows/${open.id}/entry`).send({
        entryId,
        templateVersionId: fixture.versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 350 },
          { fieldKey: 'vent_mode', json: 'bipap' },
        ],
      });

      return { ...fixture, entryId, windowId: open.id };
    }

    it('keeps the old value in an append-only revision', async () => {
      const { admin, entryId } = await recorded();

      const edited = await api(admin, 'patch', `/api/v1/check-entries/${entryId}`).send({
        values: [{ fieldKey: 'urine_output', number: 420 }],
        reason: 'Misread the bag.',
      });

      expect(edited.status).toBe(200);
      expect(edited.body.entry.editCount).toBe(1);
      expect(edited.body.entry.editedAt).not.toBeNull();

      const revisions = await api(admin, 'get', `/api/v1/check-entries/${entryId}/revisions`);
      expect(revisions.body.revisions).toHaveLength(1);
      expect(revisions.body.revisions[0].oldValue.number).toBe(350);
      expect(revisions.body.revisions[0].newValue.number).toBe(420);
      expect(revisions.body.revisions[0].reason).toBe('Misread the bag.');
    });

    it('writes no revision when nothing actually changed', async () => {
      const { admin, entryId } = await recorded();

      await api(admin, 'patch', `/api/v1/check-entries/${entryId}`).send({
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      const revisions = await api(admin, 'get', `/api/v1/check-entries/${entryId}/revisions`);
      expect(revisions.body.revisions).toEqual([]);
    });

    it('encrypts the revision history as well as the entry', async () => {
      const { admin, entryId } = await recorded();

      await api(admin, 'patch', `/api/v1/check-entries/${entryId}`).send({
        values: [{ fieldKey: 'comment', text: 'Chest sounds clear.' }],
      });

      const [row] = await h.ownerDb.execute<{ dump: string }>(
        sql`select check_entry_revisions::text as dump from check_entry_revisions limit 1`,
      );
      expect(row!.dump).not.toContain('Chest sounds clear');
    });

    /** Doc 01 §3.6: a worker edits their own entry, not somebody else's. */
    it("stops a worker changing another person's entry", async () => {
      const { participantId, entryId } = await recorded();

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const response = await api(worker, 'patch', `/api/v1/check-entries/${entryId}`).send({
        values: [{ fieldKey: 'urine_output', number: 999 }],
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('scope_denied');
    });
  });

  describe('scope', () => {
    it('keeps windows and schedules inside the caller scope', async () => {
      const { admin, participantId, templateId } = await setUp();
      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const other = await api(admin, 'post', '/api/v1/participants').send({
        firstName: 'Jordan',
        lastName: 'Nguyen',
        dateOfBirth: '1988-11-11',
        ndisNumber: '431111111',
      });
      const otherId = other.body.participant.id as string;

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const allowed = await api(worker, 'get', `/api/v1/participants/${participantId}/windows`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.windows.length).toBeGreaterThan(0);

      const denied = await api(worker, 'get', `/api/v1/participants/${otherId}/windows`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('scope_denied');
    });

    /**
     * Scope is checked before capability, so a nurse out of scope gets the same
     * answer as a worker out of scope. Reversing the order would leak whose
     * caseload is whose through the error message.
     */
    it('denies an out-of-scope nurse identically to a worker', async () => {
      const { admin } = await setUp();
      const other = await api(admin, 'post', '/api/v1/participants').send({
        firstName: 'Jordan',
        lastName: 'Nguyen',
        dateOfBirth: '1988-11-11',
        ndisNumber: '431111111',
      });
      const otherId = other.body.participant.id as string;

      const nurse = await signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' }));
      const worker = await signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'worker' }));

      const nurseResponse = await api(nurse, 'get', `/api/v1/participants/${otherId}/windows`);
      const workerResponse = await api(worker, 'get', `/api/v1/participants/${otherId}/windows`);

      expect(nurseResponse.status).toBe(workerResponse.status);
      expect(nurseResponse.body.error.message).toBe(workerResponse.body.error.message);
    });

    it('gives a worker only their own participants on the Today feed', async () => {
      const { admin, participantId, templateId } = await setUp();
      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const other = await api(admin, 'post', '/api/v1/participants').send({
        firstName: 'Jordan',
        lastName: 'Nguyen',
        dateOfBirth: '1988-11-11',
        ndisNumber: '431111111',
      });
      await api(admin, 'post', `/api/v1/participants/${other.body.participant.id}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const due = await api(worker, 'get', '/api/v1/me/windows/due');
      expect(due.status).toBe(200);
      expect(due.body.windows.length).toBeGreaterThan(0);
      expect(
        (due.body.windows as { participantId: string }[]).every(
          (one) => one.participantId === participantId,
        ),
      ).toBe(true);
    });

    it('stops a worker changing a schedule', async () => {
      const { admin, participantId, templateId } = await setUp();
      const created = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules`,
      ).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: DAY_AND_NIGHT,
      });

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const response = await api(
        worker,
        'put',
        `/api/v1/schedules/${created.body.schedule.id}/segments`,
      ).send({
        segments: [
          {
            windowMinutes: 60,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      expect(response.status).toBe(403);
    });
  });

  describe('coverage recalculation', () => {
    it('previews the change before applying it', async () => {
      const { admin, participantId, templateId } = await setUp();
      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: [
          {
            windowMinutes: 120,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      // Narrow coverage after the grid already exists.
      await api(admin, 'put', `/api/v1/participants/${participantId}/coverage-pattern`).send({
        ranges: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startTime: '09:00',
          endTime: '17:00',
        })),
      });

      const preview = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/coverage/recalculate`,
      ).send({ from: today(), to: addDays(today(), 6) });

      expect(preview.body.applied).toBe(false);
      expect(preview.body.becomingNotExpected).toBeGreaterThan(0);

      // Nothing moved yet.
      const before = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const stillExpected = (before.body.windows as { expected: boolean }[]).filter(
        (one) => one.expected,
      );
      expect(stillExpected.length).toBe(before.body.windows.length);

      const applied = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/coverage/recalculate`,
      ).send({ from: today(), to: addDays(today(), 6), apply: true });

      expect(applied.body.applied).toBe(true);

      const after = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const notExpected = (after.body.windows as { expected: boolean; status: string }[]).filter(
        (one) => !one.expected,
      );
      expect(notExpected.length).toBeGreaterThan(0);
      expect(notExpected.every((one) => one.status === 'not_expected')).toBe(true);
    });

    it('leaves a window holding an entry alone and says so', async () => {
      const { admin, participantId, templateId, versionId } = await setUp();
      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: today(),
        segments: [
          {
            windowMinutes: 120,
            anchorTime: '00:00',
            appliesFromTime: '00:00',
            appliesToTime: '24:00',
          },
        ],
      });

      const windows = await api(admin, 'get', `/api/v1/participants/${participantId}/windows`);
      const open = (
        windows.body.windows as { id: string; startsAt: string; endsAt: string }[]
      ).find((one) => new Date(one.startsAt) <= new Date() && new Date(one.endsAt) > new Date())!;

      await api(admin, 'put', `/api/v1/windows/${open.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 350 }],
      });

      // Remove all coverage, which would otherwise flip everything.
      await api(admin, 'post', `/api/v1/participants/${participantId}/coverage-exceptions`).send({
        startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        effect: 'not_covered',
        reason: 'Family holiday',
      });

      const applied = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/coverage/recalculate`,
      ).send({ from: today(), to: addDays(today(), 6), apply: true });

      expect(applied.body.skippedWithEntries).toBe(1);

      const after = await api(admin, 'get', `/api/v1/windows/${open.id}`);
      expect(after.body.window.expected).toBe(true);
      expect(after.body.window.status).toBe('partial');
    });
  });

  describe('the roadmap acceptance scenario', () => {
    /**
     * Doc 09, Phase 3 "done when": an admin defines a vent observation
     * template, sets 2-hourly through the day and 4-hourly overnight with
     * weekday-only coverage, sees the window times in the preview before
     * saving, and a worker records complete, partial, late and missed windows,
     * with weekend windows showing as not expected.
     */
    it('runs the whole thing', async () => {
      const { admin, participantId, templateId, versionId } = await setUp();

      // Weekdays only, 07:00 to 19:00.
      await api(admin, 'put', `/api/v1/participants/${participantId}/coverage-pattern`).send({
        ranges: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startTime: '07:00',
          endTime: '19:00',
        })),
      });

      // The preview, before saving.
      const preview = await api(
        admin,
        'post',
        `/api/v1/participants/${participantId}/schedules/preview`,
      ).send({ date: nextWeekday(1), segments: DAY_AND_NIGHT });
      expect(preview.body.windows).toHaveLength(10);

      const yesterday = addDays(today(), -1);
      await api(admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
        templateId,
        name: 'Vent observations',
        activeFrom: yesterday,
        segments: DAY_AND_NIGHT,
      });
      // From yesterday, so the scenario has a missed window to account for.
      // D85 means the grid has to be laid as it stood then rather than now.
      await materialiseParticipant(
        h.db,
        participantId,
        yesterday,
        addDays(today(), 7),
        new Date(`${yesterday}T00:00:00Z`),
      );
      await closeWindows(h.db);

      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, participantId);
      const worker = await signIn(h, workerUser);

      const all = await api(
        worker,
        'get',
        `/api/v1/participants/${participantId}/windows?from=${yesterday}&to=${addDays(today(), 7)}`,
      );
      const windows = all.body.windows as {
        id: string;
        status: string;
        expected: boolean;
        startsAt: string;
        endsAt: string;
        coverageReason: string | null;
      }[];

      // A weekend window is not expected, and says why.
      const weekend = windows.find(
        (one) => [0, 6].includes(new Date(one.startsAt).getUTCDay()) && !one.expected,
      );
      expect(weekend?.status).toBe('not_expected');
      expect(weekend?.coverageReason).toBe('Outside supported hours');

      // A missed one, needing a reason.
      //
      // Aged deliberately rather than picked out of whatever the clock happens
      // to have closed: a coverage pattern applies from the day it is set
      // (D38), so yesterday's windows are never expected here, and relying on
      // an earlier window from today means no missed window exists at all when
      // the suite runs just after midnight.
      const expectedToday = windows.find((one) => one.expected && one.status === 'pending');
      expect(expectedToday).toBeDefined();
      await h.ownerDb.execute(sql`
        update check_windows
        set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours'
        where id = ${expectedToday!.id}::uuid
      `);
      await closeWindows(h.db);

      const reread = await api(
        worker,
        'get',
        `/api/v1/participants/${participantId}/windows?from=${yesterday}&to=${addDays(today(), 7)}`,
      );
      const missed = (reread.body.windows as { id: string; status: string }[]).find(
        (one) => one.status === 'missed',
      );
      expect(missed).toBeDefined();

      const codes = await api(worker, 'get', '/api/v1/missed-reason-codes');
      const asleep = (codes.body.reasonCodes as { id: string; code: string }[]).find(
        (one) => one.code === 'asleep',
      )!;
      const reasoned = await api(worker, 'put', `/api/v1/windows/${missed!.id}/miss-reason`).send({
        reasonCodeId: asleep.id,
      });
      expect(reasoned.status).toBe(200);

      // A late back-fill into another closed window, which the worker may do
      // because it is inside the 24-hour cut-off.
      const late = (reread.body.windows as typeof windows).find(
        (one) => one.status === 'missed' && one.id !== missed!.id && one.expected,
      );
      if (late) {
        const backfilled = await api(worker, 'put', `/api/v1/windows/${late.id}/entry`).send({
          entryId: randomUUID(),
          templateVersionId: versionId,
          recordedAt: new Date().toISOString(),
          values: [
            { fieldKey: 'urine_output', number: 300 },
            { fieldKey: 'vent_mode', json: 'cpap' },
          ],
        });
        expect(backfilled.status).toBe(200);
        expect(backfilled.body.window.status).toBe('complete');
        expect(backfilled.body.window.isLate).toBe(true);
      }

      // A complete one and a partial one, today. Read back rather than taken
      // from the earlier list, which still holds the pre-ageing times.
      const open = (reread.body.windows as typeof windows).filter(
        (one) => new Date(one.endsAt) > new Date() && one.expected,
      );
      expect(open.length).toBeGreaterThanOrEqual(2);

      const completed = await api(worker, 'put', `/api/v1/windows/${open[0]!.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 350 },
          { fieldKey: 'vent_mode', json: 'bipap' },
          { fieldKey: 'cares', json: ['repositioned'] },
        ],
      });
      expect(completed.body.window.status).toBe('complete');
      expect(completed.body.window.isLate).toBe(false);

      const partial = await api(worker, 'put', `/api/v1/windows/${open[1]!.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: versionId,
        recordedAt: new Date().toISOString(),
        values: [{ fieldKey: 'urine_output', number: 275 }],
      });
      expect(partial.body.window.status).toBe('partial');
      expect(partial.body.window.filledRequiredCount).toBe(1);
      expect(partial.body.window.requiredFieldCount).toBe(2);

      // Every state the phase set out to produce is on the record.
      const final = await api(
        worker,
        'get',
        `/api/v1/participants/${participantId}/windows?from=${yesterday}&to=${addDays(today(), 7)}`,
      );
      const statuses = new Set(
        (final.body.windows as { status: string }[]).map((one) => one.status),
      );
      expect(statuses).toContain('complete');
      expect(statuses).toContain('partial');
      expect(statuses).toContain('missed');
      expect(statuses).toContain('not_expected');
      expect(statuses).toContain('pending');
    });
  });
});
