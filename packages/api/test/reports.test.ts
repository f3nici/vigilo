import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { closeWindows, materialiseParticipant } from '../src/services/windows.js';

const MELBOURNE = 'Australia/Melbourne';

/**
 * Reports and exports end to end (doc 01 §8, doc 04 §11).
 *
 * The compliance numbers are the point. Somebody will be asked to defend them,
 * so they are checked against windows this file put in the database on purpose
 * rather than against whatever the clock produced.
 */
describe('reports', () => {
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
    adminId: string;
    participantId: string;
    otherParticipantId: string;
    templateId: string;
    versionId: string;
  };

  async function setUp(): Promise<Fixture> {
    const adminUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const admin = await signIn(h, adminUser);

    const mine = await api(admin, 'post', '/api/v1/participants').send({
      firstName: 'Aroha',
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
      participantId: mine.body.participant.id as string,
      otherParticipantId: theirs.body.participant.id as string,
      templateId,
      versionId,
    };
  }

  /** Hourly windows across a known range, so the counting has something real. */
  async function schedule(fixture: Fixture, participantId: string): Promise<void> {
    await api(fixture.admin, 'post', `/api/v1/participants/${participantId}/schedules`).send({
      templateId: fixture.templateId,
      name: 'Hourly observations',
      activeFrom: addDays(today(), -3),
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
    await materialiseParticipant(h.db, participantId, addDays(today(), -3), today());
  }

  /**
   * A known set of outcomes, written directly.
   *
   * Deliberately not produced by driving the API and hoping the clock
   * cooperates: the phase gate is that the numbers match a hand count, so the
   * hand count has to be of windows this test decided on.
   */
  async function paint(
    participantId: string,
    plan: {
      complete: number;
      late: number;
      missedWithReason: number;
      missedBare: number;
      notExpected: number;
    },
  ): Promise<void> {
    const rows = await h.ownerDb.execute<{ id: string }>(
      sql`select id from check_windows where participant_id = ${participantId}
          order by starts_at limit 200`,
    );

    let cursor = 0;
    const take = (count: number) => rows.slice(cursor, (cursor += count)).map((row) => row.id);

    const complete = take(plan.complete);
    const late = take(plan.late);
    const missedWithReason = take(plan.missedWithReason);
    const missedBare = take(plan.missedBare);
    const notExpected = take(plan.notExpected);

    for (const [ids, status, isLate] of [
      [complete, 'complete', false],
      [late, 'complete', true],
      [missedWithReason, 'missed', false],
      [missedBare, 'missed', false],
      [notExpected, 'not_expected', false],
    ] as const) {
      if (ids.length === 0) continue;
      await h.ownerDb.execute(sql`
        update check_windows
        set status = ${status}, is_late = ${isLate},
            late_by_minutes = ${isLate ? 12 : null}
        where id = any(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})
      `);
    }

    const [code] = await h.ownerDb.execute<{ id: string }>(
      sql`select id from missed_reason_codes where code = 'asleep' limit 1`,
    );

    for (const windowId of missedWithReason) {
      await h.ownerDb.execute(sql`
        insert into window_miss_reasons (id, window_id, reason_code_id, recorded_at)
        values (${randomUUID()}::uuid, ${windowId}::uuid, ${code!.id}::uuid, now())
      `);
    }

    // Every remaining window is still pending, and pending counts as expected.
    await h.ownerDb.execute(sql`
      delete from check_windows
      where participant_id = ${participantId}::uuid and status = 'pending'
    `);
  }

  /* ------------------------------------------------------------ compliance */

  describe('the compliance report', () => {
    it('matches a hand count, with not-expected outside the denominator', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);

      // 20 windows: 9 complete, 2 complete but late, 3 missed with a reason,
      // 2 missed with none, 4 not expected. So 16 expected, 11 completed,
      // which is 69 percent.
      await paint(fixture.participantId, {
        complete: 9,
        late: 2,
        missedWithReason: 3,
        missedBare: 2,
        notExpected: 4,
      });

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/compliance?from=${addDays(today(), -3)}&to=${today()}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.report.total).toEqual({
        expected: 16,
        completed: 11,
        completedLate: 2,
        partial: 0,
        pending: 0,
        missed: 5,
        missedWithReason: 3,
        missedWithoutReason: 2,
        notExpected: 4,
      });
      expect(response.body.report.totalPercent).toBe(69);
    });

    it('groups by participant, by worker and by day', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);
      await paint(fixture.participantId, {
        complete: 4,
        late: 0,
        missedWithReason: 0,
        missedBare: 1,
        notExpected: 0,
      });

      for (const groupBy of ['participant', 'worker', 'day'] as const) {
        const response = await api(
          fixture.admin,
          'get',
          `/api/v1/reports/compliance?from=${addDays(today(), -3)}&to=${today()}&groupBy=${groupBy}`,
        );
        expect(response.status).toBe(200);
        expect(response.body.report.groupBy).toBe(groupBy);
        expect(response.body.report.rows.length).toBeGreaterThan(0);
      }
    });

    it('names the windows nobody recorded rather than dropping them', async () => {
      // Grouped by worker, a missed window has no worker on it. A per-worker
      // report that cannot show a missed check is worse than no report.
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);
      await paint(fixture.participantId, {
        complete: 0,
        late: 0,
        missedWithReason: 0,
        missedBare: 3,
        notExpected: 0,
      });

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/compliance?from=${addDays(today(), -3)}&to=${today()}&groupBy=worker`,
      );

      const labels = (response.body.report.rows as { label: string }[]).map((row) => row.label);
      expect(labels).toContain('Nobody recorded it');
    });

    it('shows a nurse only the participants they oversee', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);
      await schedule(fixture, fixture.otherParticipantId);
      await paint(fixture.participantId, {
        complete: 2,
        late: 0,
        missedWithReason: 0,
        missedBare: 0,
        notExpected: 0,
      });
      await paint(fixture.otherParticipantId, {
        complete: 5,
        late: 0,
        missedWithReason: 0,
        missedBare: 0,
        notExpected: 0,
      });

      const nurseUser = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
      await assign(h.ownerDb, nurseUser.id, fixture.participantId);
      const nurse = await signIn(h, nurseUser);

      const response = await api(
        nurse,
        'get',
        `/api/v1/reports/compliance?from=${addDays(today(), -3)}&to=${today()}`,
      );

      expect(response.body.report.total.expected).toBe(2);
      expect(response.body.report.rows).toHaveLength(1);
    });

    it('refuses a worker, who records care rather than reporting on it', async () => {
      const fixture = await setUp();
      const workerUser = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      await assign(h.ownerDb, workerUser.id, fixture.participantId);
      const worker = await signIn(h, workerUser);

      const response = await api(
        worker,
        'get',
        `/api/v1/reports/compliance?from=${today()}&to=${today()}`,
      );
      expect(response.status).toBe(403);
    });

    it('refuses a participant it cannot see rather than quietly returning nothing', async () => {
      const fixture = await setUp();
      const nurseUser = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
      await assign(h.ownerDb, nurseUser.id, fixture.participantId);
      const nurse = await signIn(h, nurseUser);

      const response = await api(
        nurse,
        'get',
        `/api/v1/reports/compliance?from=${today()}&to=${today()}&participantId=${fixture.otherParticipantId}`,
      );
      expect(response.status).toBe(403);
    });

    it('refuses a range longer than a year instead of timing out on it', async () => {
      const fixture = await setUp();
      const response = await api(
        fixture.admin,
        'get',
        '/api/v1/reports/compliance?from=2016-01-01&to=2026-01-01',
      );
      expect(response.status).toBe(422);
    });
  });

  /* ---------------------------------------------------------------- daily */

  describe('the daily report', () => {
    async function withRecords(fixture: Fixture): Promise<{ windowId: string }> {
      await schedule(fixture, fixture.participantId);
      await closeWindows(h.db);

      await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/alerts`).send(
        {
          kind: 'allergy',
          severity: 'critical',
          text: 'Anaphylaxis to peanuts',
        },
      );

      const windows = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/windows?from=${today()}&to=${today()}`,
      );
      const open = (windows.body.windows as { id: string; endsAt: string }[]).find(
        (one) => Date.parse(one.endsAt) > Date.now(),
      )!;

      await api(fixture.admin, 'put', `/api/v1/windows/${open.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: fixture.versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 325 },
          { fieldKey: 'vent_mode', json: 'bipap' },
          { fieldKey: 'comment', text: 'Settled overnight.' },
        ],
      });

      const categories = await api(fixture.admin, 'get', '/api/v1/diary-categories');
      await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/diary`).send({
        id: randomUUID(),
        categoryId: (categories.body.categories as { id: string }[])[0]!.id,
        body: 'Went to the beach in the afternoon.',
        occurredAt: new Date().toISOString(),
      });

      return { windowId: open.id };
    }

    it('puts the day together with alerts, checks and diary', async () => {
      const fixture = await setUp();
      await withRecords(fixture);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${today()}`,
      );

      expect(response.status).toBe(200);
      const report = response.body.report;

      expect(report.participant.name).toBe('Aroha Smith');
      expect(report.alerts[0].text).toBe('Anaphylaxis to peanuts');
      expect(report.days).toHaveLength(1);
      expect(report.days[0].diary[0].body).toBe('Went to the beach in the afternoon.');

      // Values are rendered the way a person reads them, not as stored keys.
      const recorded = (report.days[0].windows as { values: { display: string }[] }[]).find(
        (one) => one.values.length > 0,
      );
      expect(recorded?.values.map((value) => value.display)).toEqual([
        '325 ml',
        'BiPAP',
        'Settled overnight.',
      ]);
    });

    it('accounts for the whole day, including what was not scheduled', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);
      await h.ownerDb.execute(sql`
        update check_windows set status = 'not_expected', expected = false,
          coverage_reason = 'Family was supporting'
        where participant_id = ${fixture.participantId}::uuid
      `);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${today()}`,
      );

      const windows = response.body.report.days[0].windows as {
        expected: boolean;
        coverageReason: string | null;
      }[];
      expect(windows.length).toBeGreaterThan(0);
      expect(windows.every((one) => !one.expected)).toBe(true);
      expect(windows[0]?.coverageReason).toBe('Family was supporting');
      expect(response.body.report.total.expected).toBe(0);
    });

    it('covers a range as well as a single day', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&from=${addDays(today(), -2)}&to=${today()}`,
      );

      expect(response.body.report.days).toHaveLength(3);
    });

    it('renders a PDF a person could hand over', async () => {
      const fixture = await setUp();
      await withRecords(fixture);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily.pdf?participantId=${fixture.participantId}&date=${today()}`,
      ).buffer();

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('attachment');
      // A real PDF, not an error page with the wrong content type on it.
      expect(response.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(response.body.length).toBeGreaterThan(2000);
    });

    it('audits looking at a report and producing a PDF differently', async () => {
      // An auditor asking "who produced this document" wants a different
      // answer from "who looked at this screen" (doc 07 §4).
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);

      await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${today()}`,
      );
      await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily.pdf?participantId=${fixture.participantId}&date=${today()}`,
      ).buffer();

      const rows = await h.ownerDb.execute<{ action: string }>(
        sql`select action from audit_log where action like 'report%' order by id`,
      );
      const actions = rows.map((row) => row.action);
      expect(actions).toContain('report.daily');
      expect(actions).toContain('report.daily_pdf');
    });
  });

  /* --------------------------------------------------------------- trends */

  describe('trends', () => {
    async function withReadings(fixture: Fixture, values: number[]): Promise<void> {
      await schedule(fixture, fixture.participantId);

      const windows = await h.ownerDb.execute<{ id: string; starts_at: Date }>(
        sql`select id, starts_at from check_windows
            where participant_id = ${fixture.participantId}::uuid
            order by starts_at limit ${values.length}`,
      );

      for (const [index, value] of values.entries()) {
        const entryId = randomUUID();
        await h.ownerDb.execute(sql`
          insert into check_entries
            (id, window_id, participant_id, template_version_id, recorded_at, received_at, status)
          values (${entryId}::uuid, ${windows[index]!.id}::uuid,
                  ${fixture.participantId}::uuid, ${fixture.versionId}::uuid,
                  ${windows[index]!.starts_at}, now(), 'complete')
        `);
        await h.ownerDb.execute(sql`
          insert into check_entry_values (entry_id, field_key, value_number, unit, recorded_at)
          values (${entryId}::uuid, 'urine_output', ${value}, 'ml',
                  ${windows[index]!.starts_at})
        `);
      }
    }

    it('returns the readings with their real times', async () => {
      const fixture = await setUp();
      await withReadings(fixture, [100, 150, 200]);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/trends?participantId=${fixture.participantId}&fieldKey=urine_output&from=${addDays(today(), -3)}&to=${today()}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.series.points.map((point: { value: number }) => point.value)).toEqual([
        100, 150, 200,
      ]);
      expect(response.body.series.unit).toBe('ml');
      expect(response.body.series.label).toBe('Urine output');
      expect(response.body.series.min).toBe(100);
      expect(response.body.series.max).toBe(200);
      expect(response.body.series.mean).toBe(150);
    });

    it('reports a hole as a gap rather than drawing through it', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);

      const windows = await h.ownerDb.execute<{ id: string; starts_at: Date }>(
        sql`select id, starts_at from check_windows
            where participant_id = ${fixture.participantId}::uuid
            order by starts_at`,
      );

      // Two readings a day apart, with nothing between them.
      for (const index of [0, 24]) {
        const target = windows[index];
        if (!target) continue;
        const entryId = randomUUID();
        await h.ownerDb.execute(sql`
          insert into check_entries
            (id, window_id, participant_id, template_version_id, recorded_at, received_at, status)
          values (${entryId}::uuid, ${target.id}::uuid, ${fixture.participantId}::uuid,
                  ${fixture.versionId}::uuid, ${target.starts_at}, now(), 'complete')
        `);
        await h.ownerDb.execute(sql`
          insert into check_entry_values (entry_id, field_key, value_number, unit, recorded_at)
          values (${entryId}::uuid, 'urine_output', 250, 'ml', ${target.starts_at})
        `);
      }

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/trends?participantId=${fixture.participantId}&fieldKey=urine_output&from=${addDays(today(), -3)}&to=${today()}`,
      );

      expect(response.body.series.points).toHaveLength(2);
      expect(response.body.series.gaps).toHaveLength(1);
      expect(response.body.series.gaps[0].hours).toBe(24);
    });

    it('averages within a bucket and says how many readings it averaged', async () => {
      const fixture = await setUp();
      await withReadings(fixture, [100, 200, 300]);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/trends?participantId=${fixture.participantId}&fieldKey=urine_output&from=${addDays(today(), -3)}&to=${today()}&bucket=day`,
      );

      const points = response.body.series.points as { value: number; samples: number }[];
      expect(points).toHaveLength(1);
      expect(points[0]?.value).toBe(200);
      expect(points[0]?.samples).toBe(3);
    });

    it('lists the numeric fields there are readings for', async () => {
      const fixture = await setUp();
      await withReadings(fixture, [100]);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/trend-fields?participantId=${fixture.participantId}`,
      );

      expect(response.body.fields).toEqual([
        { fieldKey: 'urine_output', label: 'Urine output', unit: 'ml', readings: 1 },
      ]);
    });
  });

  /* --------------------------------------------------- the phase gate */

  describe('a month of data', () => {
    /**
     * The roadmap's phase gate: all four outputs in under ten seconds
     * (doc 01 §11 says the same about report generation).
     *
     * A month of hourly checks for one participant is about 720 windows, which
     * is more than a real 2-hourly participant produces and a fair stand-in
     * for several participants at once.
     */
    it('produces all four outputs in under ten seconds', async () => {
      const fixture = await setUp();

      const from = addDays(today(), -30);
      await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/schedules`)
        .send({
          templateId: fixture.templateId,
          name: 'Hourly observations',
          activeFrom: from,
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

      await materialiseParticipant(h.db, fixture.participantId, from, today());

      // An entry against every closed window, straight in, so the timing is
      // about reading a month rather than about writing one.
      await h.ownerDb.execute(sql`
        insert into check_entries
          (id, window_id, participant_id, template_version_id, recorded_at, received_at, status)
        select gen_random_uuid(), w.id, w.participant_id, w.template_version_id,
               w.starts_at, w.starts_at, 'complete'
        from check_windows w
        where w.participant_id = ${fixture.participantId}::uuid and w.ends_at < now()
      `);
      await h.ownerDb.execute(sql`
        insert into check_entry_values (entry_id, field_key, value_number, unit, recorded_at)
        select e.id, 'urine_output', 200 + (random() * 200)::int, 'ml', e.recorded_at
        from check_entries e where e.participant_id = ${fixture.participantId}::uuid
      `);
      await h.ownerDb.execute(sql`
        update check_windows set status = 'complete'
        where participant_id = ${fixture.participantId}::uuid and ends_at < now()
      `);

      const [count] = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from check_windows
            where participant_id = ${fixture.participantId}::uuid`,
      );
      expect(Number(count!.count)).toBeGreaterThan(700);

      const timings: Record<string, number> = {};

      async function timed(name: string, work: () => Promise<{ status: number }>): Promise<void> {
        const started = Date.now();
        const response = await work();
        timings[name] = Date.now() - started;
        expect(response.status).toBe(200);
      }

      await timed('compliance', () =>
        api(fixture.admin, 'get', `/api/v1/reports/compliance?from=${from}&to=${today()}`),
      );
      await timed('daily', () =>
        api(
          fixture.admin,
          'get',
          `/api/v1/reports/daily?participantId=${fixture.participantId}&from=${from}&to=${today()}`,
        ),
      );
      await timed('pdf', () =>
        api(
          fixture.admin,
          'get',
          `/api/v1/reports/daily.pdf?participantId=${fixture.participantId}&from=${from}&to=${today()}`,
        ).buffer(),
      );
      await timed('trend', () =>
        api(
          fixture.admin,
          'get',
          `/api/v1/reports/trends?participantId=${fixture.participantId}&fieldKey=urine_output&from=${from}&to=${today()}`,
        ),
      );
      await timed('csv', () =>
        api(fixture.admin, 'post', '/api/v1/exports').send({
          kind: 'checks',
          from,
          to: today(),
        }),
      );

      for (const [name, elapsed] of Object.entries(timings)) {
        expect({ name, elapsed, under: elapsed < 10_000 }).toEqual({
          name,
          elapsed,
          under: true,
        });
      }
    });
  });

  /* -------------------------------------------------------------- exports */

  /* ----------------------------------------------------------- medications */

  describe('medications in the report', () => {
    /** A scheduled dose signed off, plus a PRN one. */
    async function withMedications(fixture: Fixture) {
      const scheduled = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/medications`,
      ).send({ name: 'Keppra', form: 'tablet', dose: '250 mg', route: 'oral', startDate: today() });

      await api(
        fixture.admin,
        'put',
        `/api/v1/medications/${scheduled.body.medication.id}/schedules`,
      ).send({ schedules: [{ timeOfDay: '08:00' }, { timeOfDay: '20:00' }] });

      const prn = await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/medications`,
      ).send({ name: 'Panadol', dose: '500 mg', isPrn: true, startDate: today() });

      const doses = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/medication-doses`,
      );

      /*
       * Both records are pinned to one instant a few minutes ago, and the
       * report is asked for that instant's local date. Anchoring on "today"
       * instead would make these tests depend on the hour the suite runs: a
       * dose is only laid for a time still ahead, so before breakfast there
       * are three of them today and after dinner there are none.
       */
      const at = new Date(Date.now() - 5 * 60_000);
      const iso = at.toISOString();

      await h.ownerDb.execute(sql`
        update medication_doses set due_at = ${iso}::timestamptz
        where id = ${doses.body.doses[0].id}::uuid
      `);

      await api(
        fixture.admin,
        'put',
        `/api/v1/medication-doses/${doses.body.doses[0].id}/administration`,
      ).send({ id: randomUUID(), status: 'given', administeredAt: iso, recordedAt: iso });

      await api(
        fixture.admin,
        'post',
        `/api/v1/participants/${fixture.participantId}/medication-administrations`,
      ).send({
        id: randomUUID(),
        medicationId: prn.body.medication.id,
        status: 'given',
        administeredAt: iso,
        recordedAt: iso,
        reason: 'Reported a headache',
      });

      return localDateOf(at, MELBOURNE);
    }

    it('puts scheduled doses and PRN ones on the day, in one timeline', async () => {
      const fixture = await setUp();
      const date = await withMedications(fixture);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${date}`,
      );

      expect(response.status).toBe(200);
      const day = response.body.report.days[0];

      const given = day.medications.find(
        (one: { isPrn: boolean; status: string }) => !one.isPrn && one.status === 'given',
      );
      expect(given.medicationName).toBe('Keppra');
      expect(given.statusLabel).toBe('Given');

      const prn = day.medications.find((one: { isPrn: boolean }) => one.isPrn);
      expect(prn.reason).toBe('Reported a headache');
      expect(prn.dueAt).toBeNull();
    });

    it('leaves PRN doses out of the counting', async () => {
      // A PRN dose answered no schedule, so putting it in the denominator
      // would put a number there that nothing was ever due for.
      const fixture = await setUp();
      const date = await withMedications(fixture);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily?participantId=${fixture.participantId}&date=${date}`,
      );

      const day = response.body.report.days[0];
      const counts = response.body.report.doseTotal;

      const scheduled = day.medications.filter((one: { isPrn: boolean }) => !one.isPrn);
      const prn = day.medications.filter((one: { isPrn: boolean }) => one.isPrn);

      // Stated against the day's own contents rather than a fixed number: how
      // many scheduled doses land on today depends on the hour the suite runs.
      expect(prn).toHaveLength(1);
      expect(counts.expected + counts.notExpected).toBe(scheduled.length);
      expect(counts.given).toBe(1);
      expect(
        counts.given +
          counts.refused +
          counts.withheld +
          counts.selfAdministered +
          counts.notRequired +
          counts.pending +
          counts.missed,
      ).toBe(counts.expected);
    });

    it('renders the medication section into the PDF', async () => {
      const fixture = await setUp();
      const date = await withMedications(fixture);

      const response = await api(
        fixture.admin,
        'get',
        `/api/v1/reports/daily.pdf?participantId=${fixture.participantId}&from=${date}&to=${date}`,
      ).buffer(true);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.body.length).toBeGreaterThan(1000);
    });

    it('exports one row per sign-off, scheduled and PRN together', async () => {
      const fixture = await setUp();
      const date = await withMedications(fixture);

      const response = await api(fixture.admin, 'post', '/api/v1/exports').send({
        kind: 'medications',
        from: date,
        to: date,
      });

      expect(response.status).toBe(200);

      const lines = response.text
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');

      expect(lines[0]).toContain('medication');
      expect(lines[0]).toContain('witnessed_by');
      expect(lines).toHaveLength(3);
      expect(response.text).toContain('Keppra');
      expect(response.text).toContain('Reported a headache');
    });
  });

  describe('CSV export', () => {
    it('writes one row per entry with a column per field', async () => {
      const fixture = await setUp();
      await schedule(fixture, fixture.participantId);

      const windows = await api(
        fixture.admin,
        'get',
        `/api/v1/participants/${fixture.participantId}/windows?from=${today()}&to=${today()}`,
      );
      const open = (windows.body.windows as { id: string; endsAt: string }[]).find(
        (one) => Date.parse(one.endsAt) > Date.now(),
      )!;

      await api(fixture.admin, 'put', `/api/v1/windows/${open.id}/entry`).send({
        entryId: randomUUID(),
        templateVersionId: fixture.versionId,
        recordedAt: new Date().toISOString(),
        values: [
          { fieldKey: 'urine_output', number: 325 },
          { fieldKey: 'vent_mode', json: 'cpap' },
        ],
      });

      const response = await api(fixture.admin, 'post', '/api/v1/exports').send({
        kind: 'checks',
        from: today(),
        to: today(),
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');

      const lines = response.text
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toContain('Urine output');
      expect(lines[0]).toContain('Ventilator mode');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('Aroha Smith');
      expect(lines[1]).toContain('325 ml');
      expect(lines[1]).toContain('CPAP');
    });

    it('defuses a diary note a spreadsheet would run as a formula', async () => {
      const fixture = await setUp();
      const categories = await api(fixture.admin, 'get', '/api/v1/diary-categories');

      await api(fixture.admin, 'post', `/api/v1/participants/${fixture.participantId}/diary`).send({
        id: randomUUID(),
        categoryId: (categories.body.categories as { id: string }[])[0]!.id,
        body: '=cmd|/c calc',
        occurredAt: new Date().toISOString(),
      });

      const response = await api(fixture.admin, 'post', '/api/v1/exports').send({
        kind: 'diary',
        from: today(),
        to: today(),
      });

      // Prefixed with an apostrophe, so Excel shows the text rather than
      // running it. No quoting needed: there is no comma or newline in it.
      expect(response.text).toContain(`,'=cmd|/c calc,`);
      expect(response.text).not.toContain(`,=cmd|/c calc,`);
    });

    it('records who exported what, with the filters and the row count', async () => {
      const fixture = await setUp();

      await api(fixture.admin, 'post', '/api/v1/exports').send({
        kind: 'diary',
        from: today(),
        to: today(),
      });

      const rows = await h.ownerDb.execute<{ action: string; metadata: Record<string, unknown> }>(
        sql`select action, metadata from audit_log where action = 'export.create'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        kind: 'diary',
        from: today(),
        to: today(),
        delivery: 'inline',
      });
    });

    it('exports only what the caller can see', async () => {
      const fixture = await setUp();
      const categories = await api(fixture.admin, 'get', '/api/v1/diary-categories');
      const categoryId = (categories.body.categories as { id: string }[])[0]!.id;

      for (const participantId of [fixture.participantId, fixture.otherParticipantId]) {
        await api(fixture.admin, 'post', `/api/v1/participants/${participantId}/diary`).send({
          id: randomUUID(),
          categoryId,
          body: 'Something happened.',
          occurredAt: new Date().toISOString(),
        });
      }

      const response = await api(fixture.admin, 'post', '/api/v1/exports').send({
        kind: 'diary',
        from: today(),
        to: today(),
        participantId: fixture.participantId,
      });

      expect(response.text).toContain('Aroha Smith');
      expect(response.text).not.toContain('Jae Nguyen');
    });

    it('refuses anybody but an admin', async () => {
      const fixture = await setUp();
      const nurseUser = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
      await assign(h.ownerDb, nurseUser.id, fixture.participantId);
      const nurse = await signIn(h, nurseUser);

      const response = await api(nurse, 'post', '/api/v1/exports').send({
        kind: 'checks',
        from: today(),
        to: today(),
      });
      expect(response.status).toBe(403);
    });

    it('does not hand one admin another admin’s export', async () => {
      const fixture = await setUp();
      const otherUser = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
      const other = await signIn(h, otherUser);

      await h.ownerDb.execute(sql`
        insert into export_jobs (id, user_id, kind, from_date, to_date, status, expires_at)
        values (gen_random_uuid(), ${fixture.adminId}::uuid, 'checks',
                ${today()}, ${today()}, 'ready', now() + interval '1 day')
      `);
      const [job] = await h.ownerDb.execute<{ id: string }>(sql`select id from export_jobs`);

      const response = await api(other, 'get', `/api/v1/exports/${job!.id}`);
      expect(response.status).toBe(404);
    });

    it('refuses to download an export that has not been built', async () => {
      const fixture = await setUp();
      await h.ownerDb.execute(sql`
        insert into export_jobs (id, user_id, kind, from_date, to_date, status, expires_at)
        values (gen_random_uuid(), ${fixture.adminId}::uuid, 'checks',
                ${today()}, ${today()}, 'queued', now() + interval '1 day')
      `);
      const [job] = await h.ownerDb.execute<{ id: string }>(sql`select id from export_jobs`);

      const response = await api(fixture.admin, 'get', `/api/v1/exports/${job!.id}/download`);
      expect(response.status).toBe(409);
    });
  });
});
