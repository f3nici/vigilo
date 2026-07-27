import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import {
  addTeamScope,
  auditActions,
  createHarness,
  resetData,
  seedUser,
  signIn,
  type Harness,
  type SignedIn,
} from './helpers.js';

/**
 * Assignments and temporary grants (doc 01 §4.1).
 *
 * The last test in this file is the roadmap's Phase 2 acceptance bar: an admin
 * creates a participant, assigns a worker, and that worker sees exactly that
 * participant and nothing else.
 */

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

function as(auth: SignedIn) {
  return {
    get: (path: string) => request(h.app).get(path).set('Cookie', auth.cookies),
    post: (path: string) =>
      request(h.app).post(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
    delete: (path: string) =>
      request(h.app).delete(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
  };
}

const person = {
  firstName: 'Alice',
  lastName: 'Smith',
  dateOfBirth: '1994-03-02',
  ndisNumber: '431234567',
};

async function adminWithParticipant() {
  const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
  const api = as(await signIn(h, admin));
  const created = await api.post('/api/v1/participants').send(person);
  return { admin, api, participantId: created.body.participant.id as string };
}

function inAnHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

describe('granting access', () => {
  it('gives a worker a standing assignment', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const granted = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    expect(granted.status).toBe(201);
    expect(granted.body.assignment).toMatchObject({
      kind: 'standing',
      effective: true,
      expiresAt: null,
      userRole: 'worker',
    });
  });

  it('requires an expiry and a reason on a temporary grant', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const missing = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'temporary' });
    expect(missing.status).toBe(422);

    const complete = await api.post(`/api/v1/participants/${participantId}/assignments`).send({
      userId: worker.id,
      kind: 'temporary',
      expiresAt: inAnHour(),
      reason: 'covering a shift',
    });
    expect(complete.status).toBe(201);
    expect(complete.body.assignment.reason).toBe('covering a shift');
  });

  it('refuses an expiry that has already passed', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const response = await api.post(`/api/v1/participants/${participantId}/assignments`).send({
      userId: worker.id,
      kind: 'temporary',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      reason: 'covering a shift',
    });

    expect(response.status).toBe(422);
  });

  it('refuses to grant the same access twice', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    const again = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    expect(again.status).toBe(409);
  });

  it('refuses a suspended account', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker', status: 'suspended' });

    const response = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    expect(response.status).toBe(409);
  });

  it('refuses to assign a participant self-access account to anyone', async () => {
    const { api, participantId } = await adminWithParticipant();
    const selfAccess = await seedUser(h.ownerDb, h.keyRing, {
      role: 'participant',
      participantId,
    });

    const response = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: selfAccess.id, kind: 'standing' });

    expect(response.status).toBe(422);
  });

  it('writes a scope change so the device knows to download the record', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    const rows = await h.ownerDb.execute<{ effect: string; user_id: string }>(
      sql`select effect, user_id from sync_scope_changes`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: 'granted', user_id: worker.id });
  });

  it('audits the grant with ids only, never the reason someone typed', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await api.post(`/api/v1/participants/${participantId}/assignments`).send({
      userId: worker.id,
      kind: 'temporary',
      expiresAt: inAnHour(),
      reason: 'Alice needs an extra carer tonight',
    });

    const [row] = await h.ownerDb.execute<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_log where action = 'assignment.grant'`,
    );
    expect(JSON.stringify(row!.metadata)).not.toContain('Alice');
    expect(row!.metadata).toMatchObject({ userId: worker.id, kind: 'temporary' });
  });
});

describe('who may grant', () => {
  it('lets a team leader grant inside their own scope', async () => {
    const { participantId } = await adminWithParticipant();

    const leader = await seedUser(h.ownerDb, h.keyRing, { role: 'team_leader' });
    await addTeamScope(h.ownerDb, leader.id, participantId);
    const leaderApi = as(await signIn(h, leader));

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const granted = await leaderApi
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'temporary', expiresAt: inAnHour(), reason: 'shift cover' });

    expect(granted.status).toBe(201);
  });

  it('stops a team leader granting access to someone outside their scope', async () => {
    const { participantId } = await adminWithParticipant();

    const leader = await seedUser(h.ownerDb, h.keyRing, { role: 'team_leader' });
    const leaderApi = as(await signIn(h, leader));

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const response = await leaderApi
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('scope_denied');
  });

  it('stops a worker granting themselves access, which is the whole point', async () => {
    const { participantId } = await adminWithParticipant();

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const workerApi = as(await signIn(h, worker));

    const response = await workerApi
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    // Out of scope first: a worker with no assignment cannot even name them.
    expect(response.status).toBe(403);

    const listed = await workerApi.get('/api/v1/participants');
    expect(listed.body.participants).toHaveLength(0);
  });

  it('stops a nurse, who oversees care but does not hand out access', async () => {
    const { participantId } = await adminWithParticipant();

    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    await addTeamScope(h.ownerDb, nurse.id, participantId);
    const nurseApi = as(await signIn(h, nurse));

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const response = await nurseApi
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    expect(response.status).toBe(403);
  });
});

describe('temporary grants expire on their own', () => {
  it('stops working once the expiry passes, with nothing having to run', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const granted = await api.post(`/api/v1/participants/${participantId}/assignments`).send({
      userId: worker.id,
      kind: 'temporary',
      expiresAt: inAnHour(),
      reason: 'covering a shift',
    });

    const workerApi = as(await signIn(h, worker));
    const before = await workerApi.get(`/api/v1/participants/${participantId}`);
    expect(before.status).toBe(200);
    expect(before.body.participant.access).toMatchObject({ kind: 'temporary' });

    // Move the expiry into the past. Nothing else changes.
    await h.ownerDb.execute(sql`
      update participant_assignments
      set expires_at = now() - interval '1 minute'
      where id = ${granted.body.assignment.id}::uuid
    `);

    const after = await workerApi.get(`/api/v1/participants/${participantId}`);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('scope_denied');
  });

  it('tells the worker how long a temporary grant has left', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const expiresAt = inAnHour();

    await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'temporary', expiresAt, reason: 'covering a shift' });

    const workerApi = as(await signIn(h, worker));
    const listed = await workerApi.get('/api/v1/participants');

    expect(listed.body.participants[0].access.kind).toBe('temporary');
    expect(new Date(listed.body.participants[0].access.expiresAt).toISOString()).toBe(
      new Date(expiresAt).toISOString(),
    );
  });
});

describe('revoking access', () => {
  it('takes the participant away immediately and records the scope change', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const granted = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    const workerApi = as(await signIn(h, worker));
    expect((await workerApi.get(`/api/v1/participants/${participantId}`)).status).toBe(200);

    const revoked = await api.delete(`/api/v1/assignments/${granted.body.assignment.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.assignment.effective).toBe(false);

    expect((await workerApi.get(`/api/v1/participants/${participantId}`)).status).toBe(403);

    const rows = await h.ownerDb.execute<{ effect: string }>(
      sql`select effect from sync_scope_changes order by revision`,
    );
    expect(rows.map((row) => row.effect)).toEqual(['granted', 'revoked']);

    expect(await auditActions(h.ownerDb)).toContain('assignment.revoke');
  });

  it('refuses to revoke the same grant twice', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const granted = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });

    await api.delete(`/api/v1/assignments/${granted.body.assignment.id}`);
    const again = await api.delete(`/api/v1/assignments/${granted.body.assignment.id}`);

    expect(again.status).toBe(409);
  });

  it('keeps the revoked row, so who had access when stays answerable', async () => {
    const { api, participantId } = await adminWithParticipant();
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const granted = await api
      .post(`/api/v1/participants/${participantId}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });
    await api.delete(`/api/v1/assignments/${granted.body.assignment.id}`);

    const listed = await api.get(`/api/v1/participants/${participantId}/assignments`);
    expect(listed.body.assignments).toHaveLength(1);
    expect(listed.body.assignments[0].revokedAt).not.toBeNull();
  });
});

describe('the Phase 2 acceptance scenario', () => {
  it('an admin creates a participant, assigns a worker, and that worker sees exactly that one', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const adminApi = as(await signIn(h, admin));

    const alice = await adminApi.post('/api/v1/participants').send(person);
    const jack = await adminApi.post('/api/v1/participants').send({
      firstName: 'Jack',
      lastName: 'Nguyen',
      dateOfBirth: '1988-11-20',
      ndisNumber: '431234568',
    });
    expect(alice.status).toBe(201);
    expect(jack.status).toBe(201);

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const granted = await adminApi
      .post(`/api/v1/participants/${alice.body.participant.id}/assignments`)
      .send({ userId: worker.id, kind: 'standing' });
    expect(granted.status).toBe(201);

    const workerApi = as(await signIn(h, worker));

    const listed = await workerApi.get('/api/v1/participants');
    expect(listed.body.participants).toHaveLength(1);
    expect(listed.body.participants[0]).toMatchObject({
      id: alice.body.participant.id,
      firstName: 'Alice',
      lastName: 'Smith',
    });

    const readAlice = await workerApi.get(`/api/v1/participants/${alice.body.participant.id}`);
    expect(readAlice.status).toBe(200);

    const readJack = await workerApi.get(`/api/v1/participants/${jack.body.participant.id}`);
    expect(readJack.status).toBe(403);
    expect(readJack.body.error.code).toBe('scope_denied');

    // And the access audit can answer who opened whose record.
    const views = await h.ownerDb.execute<{ participant_id: string; actor_user_id: string }>(
      sql`select participant_id, actor_user_id from audit_log where action = 'participant.view'`,
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      participant_id: alice.body.participant.id,
      actor_user_id: worker.id,
    });
  });
});
