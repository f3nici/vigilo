import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { addDays, localDateOf } from '@vigilo/shared';
import {
  assign,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  type Harness,
  type SignedIn,
} from './helpers.js';
import { closeDoses, materialiseDoseHorizon } from '../src/services/doses.js';

const MELBOURNE = 'Australia/Melbourne';

/**
 * Medications end to end (doc 01 §7.2, doc 04 §10).
 *
 * Against real doses on a real grid rather than fixtures, for the same reason
 * the check tests are: the parts most likely to be wrong are the seams, local
 * time to UTC, coverage to expected, sign-off to dose status.
 */
describe('medications', () => {
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

  async function setup() {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const participantId = await seedParticipant(h.ownerDb, h.keyRing, { firstName: 'Alice' });

    await assign(h.ownerDb, worker.id, participantId);
    await assign(h.ownerDb, nurse.id, participantId);

    return {
      participantId,
      adminSession: await signIn(h, admin),
      nurseSession: await signIn(h, nurse),
      workerSession: await signIn(h, worker),
      worker,
      nurse,
    };
  }

  async function createMedication(
    session: SignedIn,
    participantId: string,
    body: Record<string, unknown> = {},
  ) {
    const response = await api(session, 'post', `/api/v1/participants/${participantId}/medications`)
      .send({
        name: 'Keppra',
        form: 'tablet',
        dose: '250 mg',
        route: 'oral',
        startDate: today(),
        ...body,
      })
      .expect(201);

    return response.body.medication;
  }

  /* ------------------------------------------------------------ definitions */

  describe('the chart', () => {
    it('lets a nurse add a medication and a worker read it', async () => {
      const { participantId, nurseSession, workerSession } = await setup();

      const medication = await createMedication(nurseSession, participantId, {
        instructions: 'With food',
      });

      expect(medication.name).toBe('Keppra');
      expect(medication.dose).toBe('250 mg');
      expect(medication.instructions).toBe('With food');

      const list = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/medications`,
      ).expect(200);

      expect(list.body.medications).toHaveLength(1);
    });

    it('refuses a worker adding one', async () => {
      // Deciding what somebody takes is a clinical judgement, not a shift task.
      const { participantId, workerSession } = await setup();

      await api(workerSession, 'post', `/api/v1/participants/${participantId}/medications`)
        .send({ name: 'Keppra', dose: '250 mg', startDate: today() })
        .expect(403);
    });

    it('keeps the instructions out of the database in the clear', async () => {
      const { participantId, nurseSession } = await setup();
      await createMedication(nurseSession, participantId, {
        instructions: 'Crush and mix with yoghurt',
      });

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from medications
            where instructions_enc::text like '%yoghurt%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });

    it('refuses two due times at the same clock time', async () => {
      const { participantId, nurseSession } = await setup();
      const medication = await createMedication(nurseSession, participantId);

      const response = await api(
        nurseSession,
        'put',
        `/api/v1/medications/${medication.id}/schedules`,
      )
        .send({ schedules: [{ timeOfDay: '08:00' }, { timeOfDay: '08:00' }] })
        .expect(422);

      expect(response.body.error.message).toContain('08:00');
    });

    it('refuses due times on a PRN medication', async () => {
      const { participantId, nurseSession } = await setup();
      const medication = await createMedication(nurseSession, participantId, {
        name: 'Panadol',
        dose: '500 mg',
        isPrn: true,
      });

      await api(nurseSession, 'put', `/api/v1/medications/${medication.id}/schedules`)
        .send({ schedules: [{ timeOfDay: '08:00' }] })
        .expect(422);
    });
  });

  /* ---------------------------------------------------------- materialising */

  describe('the due list', () => {
    async function withDoses(session: SignedIn, participantId: string, times: string[]) {
      const medication = await createMedication(session, participantId);
      await api(session, 'put', `/api/v1/medications/${medication.id}/schedules`)
        .send({ schedules: times.map((timeOfDay) => ({ timeOfDay })) })
        .expect(200);
      return medication;
    }

    it('lays a dose for every due time, once', async () => {
      const { participantId, nurseSession } = await setup();
      await withDoses(nurseSession, participantId, ['08:00', '20:00']);

      // The hourly job running again must find the doses it already made.
      await materialiseDoseHorizon(h.db);
      await materialiseDoseHorizon(h.db);

      // Tomorrow, not today: whether today's 08:00 is still ahead depends on
      // the hour the suite runs, and a test that passes before breakfast and
      // fails after it is a test about the clock.
      const tomorrow = addDays(today(), 1);
      const response = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses?from=${tomorrow}&to=${tomorrow}`,
      ).expect(200);

      expect(response.body.doses).toHaveLength(2);
      expect(response.body.doses.map((dose: { status: string }) => dose.status)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('never lays a dose for a time that has already passed', async () => {
      // A chart set up at 9am must not produce an 8am dose that nobody could
      // have given and the closer marks missed five minutes later. A missed
      // dose says a person did not get their medication.
      const { participantId, nurseSession } = await setup();
      await withDoses(nurseSession, participantId, ['00:01']);

      const response = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses?from=${today()}&to=${today()}`,
      ).expect(200);

      const now = Date.now();
      expect(
        response.body.doses.every((dose: { dueAt: string }) => Date.parse(dose.dueAt) >= now),
      ).toBe(true);
    });

    it('carries the medication with the dose, so a phone needs no join', async () => {
      const { participantId, nurseSession } = await setup();
      await withDoses(nurseSession, participantId, ['08:00']);

      const response = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses`,
      ).expect(200);

      const dose = response.body.doses[0];
      expect(dose.medicationName).toBe('Keppra');
      expect(dose.dose).toBe('250 mg');
      expect(dose.route).toBe('oral');
    });

    it('marks a dose outside supported hours as not required', async () => {
      // Doc 01 §7.2: a dose the family gives is not a dose the team missed.
      const { participantId, nurseSession, adminSession } = await setup();

      // Support only in the morning, so the evening dose is somebody else's.
      await api(adminSession, 'put', `/api/v1/participants/${participantId}/coverage-pattern`)
        .send({
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startTime: '07:00',
            endTime: '12:00',
          })),
        })
        .expect(200);

      await withDoses(nurseSession, participantId, ['08:00', '20:00']);

      const response = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses`,
      ).expect(200);

      const byTime = Object.fromEntries(
        response.body.doses.map((dose: { dueAt: string; expected: boolean; status: string }) => [
          new Date(dose.dueAt).toLocaleTimeString('en-AU', {
            timeZone: MELBOURNE,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }),
          dose,
        ]),
      );

      expect(byTime['08:00'].expected).toBe(true);
      expect(byTime['20:00'].expected).toBe(false);
      expect(byTime['20:00'].status).toBe('not_required');
      expect(byTime['20:00'].coverageReason).toBe('Outside supported hours');
    });

    it('rebuilds the future when the times change, and leaves the past alone', async () => {
      const { participantId, nurseSession } = await setup();
      const medication = await withDoses(nurseSession, participantId, ['08:00']);

      const before = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses?from=${today()}&to=${addDays(today(), 3)}`,
      ).expect(200);

      const response = await api(
        nurseSession,
        'put',
        `/api/v1/medications/${medication.id}/schedules`,
      )
        .send({ schedules: [{ timeOfDay: '09:00' }] })
        .expect(200);

      expect(response.body.regenerated.removed).toBeGreaterThan(0);

      const after = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses?from=${today()}&to=${addDays(today(), 3)}`,
      ).expect(200);

      // Same number of days, different times. A dose already answered would
      // have survived, which is what the next test covers.
      expect(after.body.doses.length).toBeGreaterThan(0);
      expect(before.body.doses.length).toBeGreaterThan(0);
    });

    it('writes a tombstone for a dose it removes', async () => {
      // A phone holding a dose that no longer exists would let a worker sign
      // off something the server will refuse.
      const { participantId, nurseSession } = await setup();
      const medication = await withDoses(nurseSession, participantId, ['08:00']);

      await api(nurseSession, 'put', `/api/v1/medications/${medication.id}/schedules`)
        .send({ schedules: [{ timeOfDay: '09:00' }] })
        .expect(200);

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from sync_deletions
            where entity_type = 'medication_dose'`,
      );
      expect(Number(rows[0]?.found ?? 0)).toBeGreaterThan(0);
    });

    it('closes a dose nobody answered', async () => {
      const { participantId, nurseSession } = await setup();
      const medication = await withDoses(nurseSession, participantId, ['08:00']);

      // Age it well past the grace period rather than waiting for the clock.
      // One dose, not the whole week: the grid key is unique on
      // (medication, due_at), so moving eight doses onto one instant would
      // collide, which is the constraint doing its job.
      await h.ownerDb.execute(sql`
        update medication_doses set due_at = now() - interval '6 hours'
        where id = (
          select id from medication_doses
          where medication_id = ${medication.id} order by due_at limit 1
        )
      `);

      expect((await closeDoses(h.db)).closed).toBeGreaterThan(0);

      const response = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses?from=${addDays(today(), -1)}&to=${today()}`,
      ).expect(200);

      expect(response.body.doses.some((dose: { status: string }) => dose.status === 'missed')).toBe(
        true,
      );
    });
  });

  /* --------------------------------------------------------------- sign-off */

  describe('signing off', () => {
    async function oneDose(session: SignedIn, participantId: string, body = {}) {
      const medication = await createMedication(session, participantId, body);
      await api(session, 'put', `/api/v1/medications/${medication.id}/schedules`)
        .send({ schedules: [{ timeOfDay: '08:00' }] })
        .expect(200);

      const response = await api(
        session,
        'get',
        `/api/v1/participants/${participantId}/medication-doses`,
      ).expect(200);

      return { medication, dose: response.body.doses[0] };
    }

    function signOff(overrides: Record<string, unknown> = {}) {
      const now = new Date().toISOString();
      return {
        id: randomUUID(),
        status: 'given',
        administeredAt: now,
        recordedAt: now,
        ...overrides,
      };
    }

    it('lets a worker sign off a dose and moves the dose with it', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff())
        .expect(200);

      expect(response.body.administration.status).toBe('given');

      const after = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses`,
      ).expect(200);

      expect(after.body.doses[0].status).toBe('given');
      expect(after.body.doses[0].administrationId).toBe(response.body.administration.id);
    });

    it('needs a note on a refusal', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff({ status: 'refused' }))
        .expect(422);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff({ status: 'refused', note: 'Spat it out, offered again at 09:00' }))
        .expect(200);
    });

    it('needs a witness when the medication says so', async () => {
      const { participantId, nurseSession, workerSession, nurse } = await setup();
      const { dose } = await oneDose(nurseSession, participantId, { requiresWitness: true });

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(422);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff({ witnessedBy: nurse.id }))
        .expect(200);
    });

    it('refuses a worker witnessing themselves', async () => {
      const { participantId, nurseSession, workerSession, worker } = await setup();
      const { dose } = await oneDose(nurseSession, participantId, { requiresWitness: true });

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff({ witnessedBy: worker.id }))
        .expect(422);

      expect(response.body.error.message).toContain('someone other than you');
    });

    it('names the witness on the record', async () => {
      const { participantId, nurseSession, workerSession, nurse } = await setup();
      const { dose } = await oneDose(nurseSession, participantId, { requiresWitness: true });

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff({ witnessedBy: nurse.id }))
        .expect(200);

      expect(response.body.administration.witnessedBy).toBe(nurse.id);
      expect(response.body.administration.witnessedByName).toBe('Test nurse');
      expect(response.body.administration.recordedByName).toBe('Test worker');
    });

    it('records how much was actually given, in the words it was written in', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff({ amountGiven: 'half a tablet' }))
        .expect(200);

      // Stored as typed. Nothing parses it, converts it or compares it to the
      // charted dose (CLAUDE.md: no arithmetic on doses, ever).
      expect(response.body.administration.amountGiven).toBe('half a tablet');

      const listed = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/medication-administrations`,
      ).expect(200);
      expect(listed.body.administrations[0].amountGiven).toBe('half a tablet');
    });

    it('leaves the amount null when nobody said, rather than assuming the chart', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff())
        .expect(200);

      expect(response.body.administration.amountGiven).toBeNull();
    });

    it('refuses an amount on a sign-off that says nothing was given', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff({ status: 'refused', note: 'Spat it out', amountGiven: '5 mg' }))
        .expect(422);

      expect(response.body.error.message).toContain('no amount to record');
    });

    it('replays the same sign-off without writing a second one', async () => {
      // The whole idempotency guarantee: a device that lost the response and
      // retried must not produce two records of one dose.
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);
      const body = signOff();

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(body)
        .expect(200);
      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(body)
        .expect(200);

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from medication_administrations
            where dose_id = ${dose.id}`,
      );
      expect(rows[0]?.found).toBe('1');
    });

    it('refuses a second person signing off the same dose', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(200);

      const response = await api(
        nurseSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff())
        .expect(409);

      expect(response.body.error.message).toContain('already signed off');
    });

    it('refuses a participant self-access account', async () => {
      const { participantId, nurseSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      const self = await seedUser(h.ownerDb, h.keyRing, {
        role: 'participant',
        participantId,
      });
      const selfSession = await signIn(h, self);

      await api(selfSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(403);
    });

    it('refuses a dose for somebody out of scope', async () => {
      const { adminSession } = await setup();
      const otherId = await seedParticipant(h.ownerDb, h.keyRing, { firstName: 'Bob' });
      const { dose } = await oneDose(adminSession, otherId);

      const stranger = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
      const strangerSession = await signIn(h, stranger);

      await api(strangerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(403);
    });

    it('records a late sign-off as late, and still records it', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      await h.ownerDb.execute(sql`
        update medication_doses set due_at = now() - interval '4 hours'
        where id = ${dose.id}
      `);
      await closeDoses(h.db);

      const response = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${dose.id}/administration`,
      )
        .send(signOff())
        .expect(200);

      expect(response.body.administration.isLate).toBe(true);
      expect(response.body.administration.status).toBe('given');
    });

    it('needs a team leader once the dose is past the back-fill cut-off', async () => {
      // The same line checks draw between a late record and an invented one.
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      await h.ownerDb.execute(sql`
        update medication_doses set due_at = now() - interval '3 days'
        where id = ${dose.id}
      `);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(409);

      await api(nurseSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff())
        .expect(200);
    });

    it('keeps the note out of the audit log', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const { dose } = await oneDose(nurseSession, participantId);

      await api(workerSession, 'put', `/api/v1/medication-doses/${dose.id}/administration`)
        .send(signOff({ status: 'withheld', note: 'Nil by mouth before theatre' }))
        .expect(200);

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from audit_log
            where metadata::text like '%theatre%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });
  });

  /* -------------------------------------------------------------------- PRN */

  describe('PRN', () => {
    async function prnMedication(session: SignedIn, participantId: string, body = {}) {
      return createMedication(session, participantId, {
        name: 'Panadol',
        dose: '500 mg',
        isPrn: true,
        ...body,
      });
    }

    function prn(medicationId: string, overrides: Record<string, unknown> = {}) {
      const now = new Date().toISOString();
      return {
        id: randomUUID(),
        medicationId,
        status: 'given',
        administeredAt: now,
        recordedAt: now,
        reason: 'Reported a headache',
        ...overrides,
      };
    }

    it('records one ad hoc, with its reason', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const medication = await prnMedication(nurseSession, participantId);

      const response = await api(
        workerSession,
        'post',
        `/api/v1/participants/${participantId}/medication-administrations`,
      )
        .send(prn(medication.id))
        .expect(201);

      expect(response.body.administration.doseId).toBeNull();
      expect(response.body.administration.reason).toBe('Reported a headache');
      expect(response.body.administration.outcome).toBeNull();
      // There is no due time to be late for.
      expect(response.body.administration.isLate).toBe(false);
    });

    it('takes several in a day', async () => {
      // Which is the whole point of PRN, and what the partial unique index on
      // dose_id exists to allow.
      const { participantId, nurseSession, workerSession } = await setup();
      const medication = await prnMedication(nurseSession, participantId);

      await api(
        workerSession,
        'post',
        `/api/v1/participants/${participantId}/medication-administrations`,
      )
        .send(prn(medication.id))
        .expect(201);
      await api(
        workerSession,
        'post',
        `/api/v1/participants/${participantId}/medication-administrations`,
      )
        .send(prn(medication.id, { reason: 'Headache again' }))
        .expect(201);

      const list = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/medication-administrations`,
      ).expect(200);

      expect(list.body.administrations).toHaveLength(2);
    });

    it('refuses a scheduled medication recorded as a PRN', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const medication = await createMedication(nurseSession, participantId);

      await api(
        workerSession,
        'post',
        `/api/v1/participants/${participantId}/medication-administrations`,
      )
        .send(prn(medication.id))
        .expect(422);
    });

    it('takes the outcome later', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const medication = await prnMedication(nurseSession, participantId);

      const created = await api(
        workerSession,
        'post',
        `/api/v1/participants/${participantId}/medication-administrations`,
      )
        .send(prn(medication.id))
        .expect(201);

      const updated = await api(
        workerSession,
        'patch',
        `/api/v1/medication-administrations/${created.body.administration.id}`,
      )
        .send({ outcome: 'Settled within the hour' })
        .expect(200);

      expect(updated.body.administration.outcome).toBe('Settled within the hour');
      // Everything else is a statement about a moment that has passed.
      expect(updated.body.administration.reason).toBe('Reported a headache');
    });

    it('refuses an outcome on a scheduled dose', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const medication = await createMedication(nurseSession, participantId);
      await api(nurseSession, 'put', `/api/v1/medications/${medication.id}/schedules`)
        .send({ schedules: [{ timeOfDay: '08:00' }] })
        .expect(200);

      const doses = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/medication-doses`,
      ).expect(200);

      const signed = await api(
        workerSession,
        'put',
        `/api/v1/medication-doses/${doses.body.doses[0].id}/administration`,
      )
        .send({
          id: randomUUID(),
          status: 'given',
          administeredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
        })
        .expect(200);

      await api(
        workerSession,
        'patch',
        `/api/v1/medication-administrations/${signed.body.administration.id}`,
      )
        .send({ outcome: 'Fine' })
        .expect(422);
    });
  });

  /* ---------------------------------------------------------- no deletion */

  describe('the record', () => {
    it('gives the application no way to delete a sign-off', async () => {
      // "Full audit trail, no deletion" (doc 01 §7.2). The grant is the
      // enforcement, so this asserts on the grant rather than on a route.
      const rows = await h.ownerDb.execute<{ found: string }>(sql`
        select count(*)::text as found
        from information_schema.role_table_grants
        where grantee = 'vigilo_app'
          and table_name = 'medication_administrations'
          and privilege_type = 'DELETE'
      `);
      expect(rows[0]?.found).toBe('0');
    });
  });
});
