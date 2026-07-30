import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { renderCarePlan } from '@vigilo/shared';
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

/**
 * Care plans and incidents end to end (doc 01 §7.1 and §7.3, doc 04 §10).
 *
 * The two rules worth the most attention are both about who sees what: a
 * worker reads the published plan but never the draft, and a participant
 * self-access account never sees an incident at all.
 */
describe('care plans and incidents', () => {
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

  async function setup() {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    const leader = await seedUser(h.ownerDb, h.keyRing, { role: 'team_leader' });
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const participantId = await seedParticipant(h.ownerDb, h.keyRing, { firstName: 'Aroha' });

    await assign(h.ownerDb, worker.id, participantId);
    await assign(h.ownerDb, nurse.id, participantId);
    await assign(h.ownerDb, leader.id, participantId);

    return {
      participantId,
      worker,
      nurse,
      leader,
      adminSession: await signIn(h, admin),
      nurseSession: await signIn(h, nurse),
      leaderSession: await signIn(h, leader),
      workerSession: await signIn(h, worker),
    };
  }

  /* ------------------------------------------------------------ care plans */

  describe('care plans', () => {
    const BODY = '## Seizure plan\n\n- Stay with them\n- Time the seizure\n\n**Call** the nurse.';

    async function withPlan(session: SignedIn, participantId: string, body = BODY) {
      const created = await api(session, 'post', `/api/v1/participants/${participantId}/care-plans`)
        .send({ title: 'Daily support', body })
        .expect(201);

      return created.body.carePlan;
    }

    async function draftOf(session: SignedIn, planId: string) {
      const response = await api(session, 'put', `/api/v1/care-plans/${planId}/draft`).expect(200);
      return response.body.draft;
    }

    it('lets a nurse create a plan, which starts as a draft', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);

      expect(plan.status).toBe('draft');
      expect(plan.currentVersionId).toBeNull();
      expect(plan.body).toBeNull();
      expect(plan.hasDraft).toBe(true);
    });

    it('refuses a team leader writing one', async () => {
      // Authoring a care plan is clinical authority. A team leader sets up when
      // checks happen; they do not write the standing instructions.
      const { participantId, leaderSession } = await setup();

      await api(leaderSession, 'post', `/api/v1/participants/${participantId}/care-plans`)
        .send({ title: 'Daily support' })
        .expect(403);
    });

    it('does not show a worker an unpublished draft', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      await withPlan(nurseSession, participantId);

      const list = await api(
        workerSession,
        'get',
        `/api/v1/participants/${participantId}/care-plans`,
      ).expect(200);

      // The plan row is visible, so the worker can see one is coming, but the
      // instructions are not: nobody has approved them yet.
      expect(list.body.carePlans).toHaveLength(1);
      expect(list.body.carePlans[0].body).toBeNull();
      expect(list.body.carePlans[0].unread).toBe(false);
    });

    it('refuses a worker the version history', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);

      await api(workerSession, 'get', `/api/v1/care-plans/${plan.id}/versions`).expect(403);
    });

    it('publishes a version and hands the body to a worker', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const draft = await draftOf(nurseSession, plan.id);

      const published = await api(
        nurseSession,
        'post',
        `/api/v1/care-plan-versions/${draft.id}/publish`,
      )
        .send({ changeSummary: 'First version' })
        .expect(200);

      expect(published.body.carePlan.status).toBe('published');
      expect(published.body.carePlan.currentVersion).toBe(1);

      const read = await api(workerSession, 'get', `/api/v1/care-plans/${plan.id}`).expect(200);
      expect(read.body.carePlan.body).toContain('Seizure plan');
      expect(read.body.carePlan.changeSummary).toBe('First version');
    });

    it('requires a change summary to publish', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const draft = await draftOf(nurseSession, plan.id);

      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${draft.id}/publish`)
        .send({ changeSummary: '' })
        .expect(422);
    });

    it('refuses editing a published version', async () => {
      // A published version is what the record says the instructions were.
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const draft = await draftOf(nurseSession, plan.id);

      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${draft.id}/publish`)
        .send({ changeSummary: 'First version' })
        .expect(200);

      const response = await api(nurseSession, 'patch', `/api/v1/care-plan-versions/${draft.id}`)
        .send({ body: 'rewritten' })
        .expect(409);

      expect(response.body.error.message).toContain('new draft');
    });

    it('starts a new draft from what is published, not from a blank page', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const first = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${first.id}/publish`)
        .send({ changeSummary: 'First version' })
        .expect(200);

      const second = await draftOf(nurseSession, plan.id);

      expect(second.id).not.toBe(first.id);
      expect(second.version).toBe(2);
      // Copied forward, because starting blank is how a paragraph gets lost.
      expect(second.body).toBe(BODY);
    });

    it('supersedes the previous version on publish', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const first = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${first.id}/publish`)
        .send({ changeSummary: 'First' })
        .expect(200);

      const second = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'patch', `/api/v1/care-plan-versions/${second.id}`)
        .send({ body: '## Updated\n\nNew instructions.' })
        .expect(200);
      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${second.id}/publish`)
        .send({ changeSummary: 'Rewrote the seizure plan' })
        .expect(200);

      const versions = await api(
        nurseSession,
        'get',
        `/api/v1/care-plans/${plan.id}/versions`,
      ).expect(200);

      const byNumber = new Map(
        (versions.body.versions as { version: number; status: string }[]).map((one) => [
          one.version,
          one.status,
        ]),
      );
      expect(byNumber.get(1)).toBe('superseded');
      expect(byNumber.get(2)).toBe('published');
    });

    it('discards a draft but never a published version', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const first = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${first.id}/publish`)
        .send({ changeSummary: 'First' })
        .expect(200);

      await api(nurseSession, 'delete', `/api/v1/care-plan-versions/${first.id}`).expect(409);

      const second = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'delete', `/api/v1/care-plan-versions/${second.id}`).expect(204);
    });

    /* ----------------------------------------------------- unread markers */

    describe('the unread marker', () => {
      async function publishedPlan(session: SignedIn, participantId: string) {
        const plan = await withPlan(session, participantId);
        const draft = await draftOf(session, plan.id);
        await api(session, 'post', `/api/v1/care-plan-versions/${draft.id}/publish`)
          .send({ changeSummary: 'First' })
          .expect(200);
        return plan;
      }

      it('marks a newly published plan unread for a worker', async () => {
        const { participantId, nurseSession, workerSession } = await setup();
        const plan = await publishedPlan(nurseSession, participantId);

        const before = await api(
          workerSession,
          'get',
          `/api/v1/participants/${participantId}/care-plans`,
        ).expect(200);
        expect(before.body.carePlans[0].unread).toBe(true);

        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send({ id: randomUUID(), readAt: new Date().toISOString() })
          .expect(200);

        const after = await api(
          workerSession,
          'get',
          `/api/v1/participants/${participantId}/care-plans`,
        ).expect(200);
        expect(after.body.carePlans[0].unread).toBe(false);
      });

      it('goes unread again when a new version is published', async () => {
        const { participantId, nurseSession, workerSession } = await setup();
        const plan = await publishedPlan(nurseSession, participantId);

        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send({ id: randomUUID(), readAt: new Date().toISOString() })
          .expect(200);

        const second = await draftOf(nurseSession, plan.id);
        await api(nurseSession, 'post', `/api/v1/care-plan-versions/${second.id}/publish`)
          .send({ changeSummary: 'Changed the plan' })
          .expect(200);

        const after = await api(workerSession, 'get', `/api/v1/care-plans/${plan.id}`).expect(200);
        expect(after.body.carePlan.unread).toBe(true);
      });

      it('records one receipt however many times the worker opens it', async () => {
        const { participantId, nurseSession, workerSession } = await setup();
        const plan = await publishedPlan(nurseSession, participantId);
        const body = { id: randomUUID(), readAt: new Date().toISOString() };

        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send(body)
          .expect(200);
        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send(body)
          .expect(200);
        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send({ id: randomUUID(), readAt: new Date().toISOString() })
          .expect(200);

        const rows = await h.ownerDb.execute<{ count: string }>(
          sql`select count(*)::text as count from care_plan_reads`,
        );
        expect(rows[0]?.count).toBe('1');
      });

      it('tells an author who has read it', async () => {
        const { participantId, nurseSession, workerSession, worker } = await setup();
        const plan = await publishedPlan(nurseSession, participantId);

        await api(workerSession, 'post', `/api/v1/care-plans/${plan.id}/read`)
          .send({ id: randomUUID(), readAt: new Date().toISOString() })
          .expect(200);

        const receipts = await api(
          nurseSession,
          'get',
          `/api/v1/care-plans/${plan.id}/read-receipts`,
        ).expect(200);

        expect(receipts.body.receipts).toHaveLength(1);
        expect(receipts.body.receipts[0].userId).toBe(worker.id);
      });
    });

    it('keeps the body out of the database in the clear', async () => {
      const { participantId, nurseSession } = await setup();
      await withPlan(
        nurseSession,
        participantId,
        '## Seizure plan\n\nMidazolam if over 5 minutes.',
      );

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from care_plan_versions
            where body_enc::text like '%Midazolam%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });

    it('keeps the body out of the audit log', async () => {
      const { participantId, nurseSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      const draft = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'patch', `/api/v1/care-plan-versions/${draft.id}`)
        .send({ body: '## Plan\n\nMidazolam if over 5 minutes.' })
        .expect(200);

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from audit_log
            where metadata::text like '%Midazolam%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });

    it('stores the source, so nothing renderable is ever written down', async () => {
      // D63. The stored bytes are what the nurse typed; HTML only exists at the
      // moment of rendering, from one shared function.
      const { participantId, nurseSession, workerSession } = await setup();
      const plan = await withPlan(
        nurseSession,
        participantId,
        '## Heading\n\n<script>alert(1)</script>',
      );
      const draft = await draftOf(nurseSession, plan.id);
      await api(nurseSession, 'post', `/api/v1/care-plan-versions/${draft.id}/publish`)
        .send({ changeSummary: 'First' })
        .expect(200);

      const read = await api(workerSession, 'get', `/api/v1/care-plans/${plan.id}`).expect(200);
      const body = read.body.carePlan.body as string;

      expect(body).toContain('<script>');
      expect(renderCarePlan(body)).not.toContain('<script>');
      expect(renderCarePlan(body)).toContain('&lt;script&gt;');
    });

    it('audits reading one, because views are logged as well as writes', async () => {
      const { participantId, nurseSession, workerSession } = await setup();
      const plan = await withPlan(nurseSession, participantId);
      await api(workerSession, 'get', `/api/v1/care-plans/${plan.id}`).expect(200);

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from audit_log where action = 'care_plan.view'`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
    });

    it('refuses a plan for somebody out of scope', async () => {
      const { adminSession } = await setup();
      const otherId = await seedParticipant(h.ownerDb, h.keyRing, { firstName: 'Bob' });
      const plan = await withPlan(adminSession, otherId);

      const stranger = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
      const strangerSession = await signIn(h, stranger);

      await api(strangerSession, 'get', `/api/v1/care-plans/${plan.id}`).expect(403);
    });
  });

  /* -------------------------------------------------------------- incidents */

  describe('incidents', () => {
    function body(overrides: Record<string, unknown> = {}) {
      const now = Date.now();
      return {
        id: randomUUID(),
        occurredAt: new Date(now - 3_600_000).toISOString(),
        discoveredAt: new Date(now - 3_000_000).toISOString(),
        severity: 'moderate',
        summary: 'Fell in the bathroom',
        detail: 'Found on the floor beside the shower.',
        immediateAction: 'Helped up, checked for injury, called the nurse.',
        ...overrides,
      };
    }

    async function raise(session: SignedIn, participantId: string, overrides = {}) {
      const response = await api(session, 'post', `/api/v1/participants/${participantId}/incidents`)
        .send(body(overrides))
        .expect(201);
      return response.body.incident;
    }

    it('lets a worker raise one', async () => {
      // The person who was there is the person who saw it.
      const { participantId, workerSession } = await setup();
      const incident = await raise(workerSession, participantId);

      expect(incident.status).toBe('open');
      expect(incident.summary).toBe('Fell in the bathroom');
      expect(incident.reportedByName).toBe('Test worker');
    });

    it('refuses a discovery before the event', async () => {
      const { participantId, workerSession } = await setup();
      await api(workerSession, 'post', `/api/v1/participants/${participantId}/incidents`)
        .send(body({ discoveredAt: new Date(Date.now() - 7_200_000).toISOString() }))
        .expect(422);
    });

    it('applies the same request twice without raising two incidents', async () => {
      const { participantId, workerSession } = await setup();
      const payload = body();

      await api(workerSession, 'post', `/api/v1/participants/${participantId}/incidents`)
        .send(payload)
        .expect(201);
      await api(workerSession, 'post', `/api/v1/participants/${participantId}/incidents`)
        .send(payload)
        .expect(201);

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from incidents`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    /* ------------------------------------------------ the participant rule */

    describe('a participant self-access account', () => {
      async function selfSession(participantId: string) {
        const self = await seedUser(h.ownerDb, h.keyRing, { role: 'participant', participantId });
        return signIn(h, self);
      }

      it('cannot list incidents about itself', async () => {
        // Doc 03 §9 in bold: never visible to a participant account, enforced
        // in the scope layer rather than only in the UI.
        const { participantId, workerSession } = await setup();
        await raise(workerSession, participantId);
        const session = await selfSession(participantId);

        await api(session, 'get', `/api/v1/participants/${participantId}/incidents`).expect(403);
      });

      it('cannot read one by its id', async () => {
        const { participantId, workerSession } = await setup();
        const incident = await raise(workerSession, participantId);
        const session = await selfSession(participantId);

        await api(session, 'get', `/api/v1/incidents/${incident.id}`).expect(403);
      });

      it('cannot raise one', async () => {
        const { participantId } = await setup();
        const session = await selfSession(participantId);

        await api(session, 'post', `/api/v1/participants/${participantId}/incidents`)
          .send(body())
          .expect(403);
      });

      it('cannot download the PDF', async () => {
        const { participantId, workerSession } = await setup();
        const incident = await raise(workerSession, participantId);
        const session = await selfSession(participantId);

        await api(session, 'get', `/api/v1/incidents/${incident.id}/pdf`).expect(403);
      });

      it('cannot be given a follow-up action', async () => {
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        const self = await seedUser(h.ownerDb, h.keyRing, {
          role: 'participant',
          participantId,
        });

        await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/actions`)
          .send({ id: randomUUID(), action: 'Order a shower mat', assignedTo: self.id })
          .expect(422);
      });
    });

    /* ------------------------------------------------------- the workflow */

    describe('the workflow', () => {
      it('lets a team leader close one, with notes', async () => {
        const { participantId, workerSession, leaderSession } = await setup();
        const incident = await raise(workerSession, participantId);

        const closed = await api(leaderSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Reviewed with the team, shower mat ordered.' })
          .expect(200);

        expect(closed.body.incident.status).toBe('closed');
        expect(closed.body.incident.closedByName).toBe('Test team_leader');
        expect(closed.body.actionsOutstanding).toBe(0);
      });

      it('refuses a worker closing one', async () => {
        const { participantId, workerSession } = await setup();
        const incident = await raise(workerSession, participantId);

        await api(workerSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'All fine' })
          .expect(403);
      });

      it('requires closure notes', async () => {
        const { participantId, workerSession, leaderSession } = await setup();
        const incident = await raise(workerSession, participantId);

        await api(leaderSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: '   ' })
          .expect(422);
      });

      it('refuses closing one that is already closed', async () => {
        const { participantId, workerSession, leaderSession } = await setup();
        const incident = await raise(workerSession, participantId);
        await api(leaderSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Done' })
          .expect(200);

        await api(leaderSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Done again' })
          .expect(409);
      });

      it('reopens with a reason, which lands in the audit log', async () => {
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Done' })
          .expect(200);

        const reopened = await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/reopen`)
          .send({ reason: 'Family raised a concern' })
          .expect(200);

        expect(reopened.body.incident.status).toBe('under_review');
        expect(reopened.body.incident.closedAt).toBeNull();

        const rows = await h.ownerDb.execute<{ found: string }>(
          sql`select count(*)::text as found from audit_log
              where action = 'incident.reopen' and metadata::text like '%Family raised a concern%'`,
        );
        expect(rows[0]?.found).toBe('1');
      });

      it('tells a worker to use reopen rather than editing a closed one back open', async () => {
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Done' })
          .expect(200);

        const response = await api(nurseSession, 'patch', `/api/v1/incidents/${incident.id}`)
          .send({ status: 'open' })
          .expect(409);

        expect(response.body.error.message).toContain('Reopen');
      });

      it('refuses a worker editing somebody else’s incident', async () => {
        const { participantId, nurseSession, workerSession } = await setup();
        const incident = await raise(nurseSession, participantId);

        await api(workerSession, 'patch', `/api/v1/incidents/${incident.id}`)
          .send({ summary: 'Rewritten by somebody else' })
          .expect(403);
      });

      it('lets the reporter correct their own', async () => {
        const { participantId, workerSession } = await setup();
        const incident = await raise(workerSession, participantId);

        const updated = await api(workerSession, 'patch', `/api/v1/incidents/${incident.id}`)
          .send({ summary: 'Fell in the bathroom, no injury' })
          .expect(200);

        expect(updated.body.incident.summary).toBe('Fell in the bathroom, no injury');
      });
    });

    /* ---------------------------------------------------- follow-up actions */

    describe('follow-up actions', () => {
      it('adds one with an assignee and a due date', async () => {
        const { participantId, workerSession, nurseSession, worker } = await setup();
        const incident = await raise(workerSession, participantId);

        const response = await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/actions`)
          .send({
            id: randomUUID(),
            action: 'Order a shower mat',
            assignedTo: worker.id,
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .expect(201);

        expect(response.body.incident.actions).toHaveLength(1);
        expect(response.body.incident.actions[0].assignedToName).toBe('Test worker');
      });

      it('completes one with a note', async () => {
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        const withAction = await api(
          nurseSession,
          'post',
          `/api/v1/incidents/${incident.id}/actions`,
        )
          .send({ id: randomUUID(), action: 'Order a shower mat' })
          .expect(201);

        const actionId = withAction.body.incident.actions[0].id as string;
        const done = await api(
          workerSession,
          'post',
          `/api/v1/incident-actions/${actionId}/complete`,
        )
          .send({ note: 'Arrived and fitted' })
          .expect(200);

        expect(done.body.incident.actions[0].completedAt).not.toBeNull();
        expect(done.body.incident.actions[0].completedByName).toBe('Test worker');
        expect(done.body.incident.actions[0].note).toBe('Arrived and fitted');
      });

      it('refuses completing one twice', async () => {
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        const withAction = await api(
          nurseSession,
          'post',
          `/api/v1/incidents/${incident.id}/actions`,
        )
          .send({ id: randomUUID(), action: 'Order a shower mat' })
          .expect(201);

        const actionId = withAction.body.incident.actions[0].id as string;
        await api(workerSession, 'post', `/api/v1/incident-actions/${actionId}/complete`)
          .send({})
          .expect(200);
        await api(workerSession, 'post', `/api/v1/incident-actions/${actionId}/complete`)
          .send({})
          .expect(409);
      });

      it('says how many were outstanding when it was closed', async () => {
        // Closing a review does not finish the work, and the reader is told.
        const { participantId, workerSession, nurseSession } = await setup();
        const incident = await raise(workerSession, participantId);
        await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/actions`)
          .send({ id: randomUUID(), action: 'Order a shower mat' })
          .expect(201);
        await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/actions`)
          .send({ id: randomUUID(), action: 'Review the bathroom' })
          .expect(201);

        const closed = await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/close`)
          .send({ closureNotes: 'Reviewed, actions in hand.' })
          .expect(200);

        expect(closed.body.actionsOutstanding).toBe(2);
      });
    });

    it('renders a PDF a person could hand over', async () => {
      const { participantId, workerSession, nurseSession } = await setup();
      const incident = await raise(workerSession, participantId, {
        injuries: 'Graze to the left elbow.',
        involved: 'Aroha, and Sam who found her.',
        familyNotifiedAt: new Date().toISOString(),
      });
      await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/actions`)
        .send({ id: randomUUID(), action: 'Order a shower mat' })
        .expect(201);
      await api(nurseSession, 'post', `/api/v1/incidents/${incident.id}/close`)
        .send({ closureNotes: 'Reviewed with the team.' })
        .expect(200);

      const response = await api(nurseSession, 'get', `/api/v1/incidents/${incident.id}/pdf`)
        .buffer(true)
        .expect(200);

      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.body.length).toBeGreaterThan(1000);

      const rows = await h.ownerDb.execute<{ count: string }>(
        sql`select count(*)::text as count from audit_log where action = 'incident.export_pdf'`,
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('keeps the narrative out of the database in the clear', async () => {
      const { participantId, workerSession } = await setup();
      await raise(workerSession, participantId, {
        detail: 'She was found beside the shower with a graze.',
      });

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from incidents
            where detail_enc::text like '%graze%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });

    it('keeps the narrative out of the audit log', async () => {
      const { participantId, workerSession } = await setup();
      await raise(workerSession, participantId, {
        detail: 'She was found beside the shower with a graze.',
      });

      const rows = await h.ownerDb.execute<{ found: string }>(
        sql`select count(*)::text as found from audit_log
            where metadata::text like '%graze%'`,
      );
      expect(rows[0]?.found).toBe('0');
    });

    it('gives the application no way to delete one', async () => {
      const rows = await h.ownerDb.execute<{ found: string }>(sql`
        select count(*)::text as found
        from information_schema.role_table_grants
        where grantee = 'vigilo_app'
          and table_name in ('incidents', 'incident_actions')
          and privilege_type = 'DELETE'
      `);
      expect(rows[0]?.found).toBe('0');
    });

    it('filters by status and severity', async () => {
      const { participantId, workerSession, nurseSession } = await setup();
      await raise(workerSession, participantId, { severity: 'low' });
      const high = await raise(workerSession, participantId, { severity: 'high' });
      await api(nurseSession, 'post', `/api/v1/incidents/${high.id}/close`)
        .send({ closureNotes: 'Done' })
        .expect(200);

      const open = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/incidents?status=open`,
      ).expect(200);
      expect(open.body.incidents).toHaveLength(1);

      const severe = await api(
        nurseSession,
        'get',
        `/api/v1/participants/${participantId}/incidents?severity=high`,
      ).expect(200);
      expect(severe.body.incidents).toHaveLength(1);
      expect(severe.body.incidents[0].id).toBe(high.id);
    });

    it('shows a worker only incidents for participants they are assigned to', async () => {
      const { participantId, workerSession, adminSession } = await setup();
      await raise(workerSession, participantId);

      const otherId = await seedParticipant(h.ownerDb, h.keyRing, { firstName: 'Bob' });
      await raise(adminSession, otherId);

      const recent = await api(workerSession, 'get', '/api/v1/me/incidents/recent').expect(200);
      expect(recent.body.incidents).toHaveLength(1);
      expect(recent.body.incidents[0].participantId).toBe(participantId);
    });
  });
});
