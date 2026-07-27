import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import {
  assign,
  auditActions,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  type Harness,
  type SignedIn,
} from './helpers.js';

/**
 * Phase 2: the participant record itself.
 *
 * The things worth proving here are that identifying data never reaches the
 * database in the clear, that archiving keeps the row, and that every route
 * checks scope before it checks anything else.
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

const alice = {
  firstName: 'Alice',
  lastName: 'Smith',
  preferredName: 'Ali',
  dateOfBirth: '1994-03-02',
  ndisNumber: '431234567',
  address: '12 Example Street, Melbourne',
  phone: '0400 000 000',
  email: 'alice@example.org',
};

function as(auth: SignedIn) {
  return {
    get: (path: string) => request(h.app).get(path).set('Cookie', auth.cookies),
    post: (path: string) =>
      request(h.app).post(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
    patch: (path: string) =>
      request(h.app).patch(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
    put: (path: string) =>
      request(h.app).put(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
    delete: (path: string) =>
      request(h.app).delete(path).set('Cookie', auth.cookies).set('X-CSRF-Token', auth.csrfToken),
  };
}

async function signInAsAdmin() {
  const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
  return { admin, api: as(await signIn(h, admin)) };
}

describe('creating a participant', () => {
  it('round-trips every field through encryption', async () => {
    const { api } = await signInAsAdmin();

    const created = await api.post('/api/v1/participants').send(alice);
    expect(created.status).toBe(201);
    expect(created.body.participant.firstName).toBe('Alice');
    expect(created.body.participant.preferredName).toBe('Ali');

    const read = await api.get(`/api/v1/participants/${created.body.participant.id}`);
    expect(read.status).toBe(200);
    expect(read.body.participant).toMatchObject({
      firstName: 'Alice',
      lastName: 'Smith',
      preferredName: 'Ali',
      dateOfBirth: '1994-03-02',
      ndisNumber: '431234567',
      address: '12 Example Street, Melbourne',
      phone: '0400 000 000',
      email: 'alice@example.org',
    });
  });

  it('leaves nothing identifying in the clear in the database', async () => {
    const { api } = await signInAsAdmin();
    await api.post('/api/v1/participants').send(alice);

    const [row] = await h.ownerDb.execute<{ dump: string }>(
      sql`select participants::text as dump from participants limit 1`,
    );

    const dump = row!.dump;
    for (const secret of [
      'Alice',
      'Smith',
      'Ali',
      '431234567',
      '1994-03-02',
      'alice@example.org',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('normalises a spaced NDIS number so the same person cannot be added twice', async () => {
    const { api } = await signInAsAdmin();

    const first = await api.post('/api/v1/participants').send(alice);
    expect(first.status).toBe(201);

    const again = await api
      .post('/api/v1/participants')
      .send({ ...alice, firstName: 'Alicia', ndisNumber: '431 234 567' });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
  });

  it('rejects a date of birth that does not exist', async () => {
    const { api } = await signInAsAdmin();
    const response = await api.post('/api/v1/participants').send({
      ...alice,
      dateOfBirth: '2001-02-29',
    });
    expect(response.status).toBe(422);
  });

  it('records the creation without the name in the audit metadata', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);

    const [row] = await h.ownerDb.execute<{ metadata: Record<string, unknown>; entity_id: string }>(
      sql`select metadata, entity_id from audit_log where action = 'participant.create'`,
    );

    expect(row!.entity_id).toBe(created.body.participant.id);
    expect(JSON.stringify(row!.metadata)).not.toContain('Smith');
  });

  it('refuses a worker, who may read a record but never create one', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const api = as(await signIn(h, worker));

    const response = await api.post('/api/v1/participants').send(alice);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('scope_denied');
  });
});

describe('updating a participant', () => {
  it('moves the surname blind index with the surname', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const before = await h.ownerDb.execute<{ bidx: string }>(
      sql`select encode(name_search_bidx, 'hex') as bidx from participants where id = ${id}::uuid`,
    );

    await api.patch(`/api/v1/participants/${id}`).send({ lastName: 'Nguyen' });

    const after = await h.ownerDb.execute<{ bidx: string }>(
      sql`select encode(name_search_bidx, 'hex') as bidx from participants where id = ${id}::uuid`,
    );

    expect(after[0]!.bidx).not.toBe(before[0]!.bidx);
  });

  it('clears an optional field when it is sent as null', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    await api.patch(`/api/v1/participants/${id}`).send({ phone: null });

    const read = await api.get(`/api/v1/participants/${id}`);
    expect(read.body.participant.phone).toBeNull();
    // Untouched fields stay put.
    expect(read.body.participant.address).toBe(alice.address);
  });

  it('refuses an empty change rather than writing a pointless revision', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);

    const response = await api
      .patch(`/api/v1/participants/${created.body.participant.id}`)
      .send({});
    expect(response.status).toBe(422);
  });

  it('refuses to move an NDIS number onto someone who already has it', async () => {
    const { api } = await signInAsAdmin();
    await api.post('/api/v1/participants').send(alice);
    const second = await api
      .post('/api/v1/participants')
      .send({ ...alice, ndisNumber: '431234568', email: null });

    const response = await api
      .patch(`/api/v1/participants/${second.body.participant.id}`)
      .send({ ndisNumber: '431234567' });

    expect(response.status).toBe(409);
  });
});

describe('archiving', () => {
  it('keeps the row and can bring it back', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const archived = await api.post(`/api/v1/participants/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.participant.status).toBe('archived');
    expect(archived.body.participant.archivedAt).not.toBeNull();

    const [{ count }] = await h.ownerDb.execute<{ count: string }>(
      sql`select count(*)::text as count from participants`,
    );
    expect(count).toBe('1');

    const restored = await api.post(`/api/v1/participants/${id}/restore`);
    expect(restored.body.participant.status).toBe('active');
    expect(restored.body.participant.archivedAt).toBeNull();
  });

  it('drops an archived participant from the list unless they are asked for', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    await api.post(`/api/v1/participants/${created.body.participant.id}/archive`);

    const listed = await api.get('/api/v1/participants');
    expect(listed.body.participants).toHaveLength(0);

    const withArchived = await api.get('/api/v1/participants?includeArchived=true');
    expect(withArchived.body.participants).toHaveLength(1);
  });

  it('leaves an audit trail for both directions', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    await api.post(`/api/v1/participants/${created.body.participant.id}/archive`);
    await api.post(`/api/v1/participants/${created.body.participant.id}/restore`);

    const actions = await auditActions(h.ownerDb);
    expect(actions).toContain('participant.archive');
    expect(actions).toContain('participant.restore');
  });
});

describe('NDIS lookup', () => {
  it('finds an exact match without decrypting the table', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);

    const found = await api.get('/api/v1/participants/lookup?ndis=431%20234%20567');
    expect(found.status).toBe(200);
    expect(found.body.participant.id).toBe(created.body.participant.id);
  });

  it('answers null rather than an error when nobody matches', async () => {
    const { api } = await signInAsAdmin();
    const found = await api.get('/api/v1/participants/lookup?ndis=999999999');
    expect(found.status).toBe(200);
    expect(found.body.participant).toBeNull();
  });

  it('records the search but never the number searched for', async () => {
    const { api } = await signInAsAdmin();
    await api.get('/api/v1/participants/lookup?ndis=431234567');

    const [row] = await h.ownerDb.execute<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_log where action = 'participant.lookup'`,
    );
    expect(JSON.stringify(row!.metadata)).not.toContain('431234567');
    expect(row!.metadata).toMatchObject({ found: false });
  });

  it('is admin only', async () => {
    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    const api = as(await signIn(h, nurse));
    const response = await api.get('/api/v1/participants/lookup?ndis=431234567');
    expect(response.status).toBe(403);
  });
});

describe('alerts', () => {
  it('lets a nurse add one and a worker in scope read it', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const created = await adminApi.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    await assign(h.ownerDb, nurse.id, id);
    const nurseApi = as(await signIn(h, nurse));

    const alert = await nurseApi.post(`/api/v1/participants/${id}/alerts`).send({
      kind: 'allergy',
      severity: 'critical',
      text: 'Anaphylaxis: peanuts. EpiPen in kitchen drawer.',
    });
    expect(alert.status).toBe(201);

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, id);
    const workerApi = as(await signIn(h, worker));

    const read = await workerApi.get(`/api/v1/participants/${id}`);
    expect(read.body.participant.alerts).toHaveLength(1);
    expect(read.body.participant.alerts[0].text).toContain('EpiPen');
  });

  it('refuses a worker who tries to write one', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const created = await adminApi.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, id);
    const workerApi = as(await signIn(h, worker));

    const response = await workerApi
      .post(`/api/v1/participants/${id}/alerts`)
      .send({ kind: 'other', severity: 'info', text: 'nope' });

    expect(response.status).toBe(403);
  });

  it('deactivates rather than deletes, and hides it from the pinned list', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const alert = await api
      .post(`/api/v1/participants/${id}/alerts`)
      .send({ kind: 'medical', severity: 'warning', text: 'Seizure plan in care plan section 4' });

    await api.delete(`/api/v1/participants/${id}/alerts/${alert.body.alert.id}`);

    const detail = await api.get(`/api/v1/participants/${id}`);
    expect(detail.body.participant.alerts).toHaveLength(0);

    const [{ count }] = await h.ownerDb.execute<{ count: string }>(
      sql`select count(*)::text as count from participant_alerts`,
    );
    expect(count).toBe('1');
  });

  it('keeps the alert text out of the audit metadata', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);

    await api
      .post(`/api/v1/participants/${created.body.participant.id}/alerts`)
      .send({ kind: 'allergy', severity: 'critical', text: 'Anaphylaxis: peanuts' });

    const [row] = await h.ownerDb.execute<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_log where action = 'alert.create'`,
    );
    expect(JSON.stringify(row!.metadata)).not.toContain('peanuts');
    expect(row!.metadata).toMatchObject({ kind: 'allergy', severity: 'critical' });
  });
});

describe('emergency contacts and plan', () => {
  it('keeps one primary contact and puts them first', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const first = await api.post(`/api/v1/participants/${id}/contacts`).send({
      name: 'Jo Smith',
      relationship: 'Mother',
      phonePrimary: '0400 111 111',
      isPrimary: true,
      sortOrder: 10,
    });
    expect(first.status).toBe(201);

    await api.post(`/api/v1/participants/${id}/contacts`).send({
      name: 'Sam Smith',
      relationship: 'Brother',
      phonePrimary: '0400 222 222',
      isPrimary: true,
      sortOrder: 20,
    });

    const contacts = await api.get(`/api/v1/participants/${id}/contacts`);
    expect(contacts.body.contacts[0].name).toBe('Sam Smith');
    expect(contacts.body.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary)).toHaveLength(
      1,
    );
  });

  it('upserts the emergency plan rather than stacking versions', async () => {
    const { api } = await signInAsAdmin();
    const created = await api.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    await api
      .put(`/api/v1/participants/${id}/emergency-plan`)
      .send({ title: 'Seizure response', body: 'Call 000 if longer than five minutes.' });

    const second = await api
      .put(`/api/v1/participants/${id}/emergency-plan`)
      .send({ title: 'Seizure response', body: 'Call 000 if longer than three minutes.' });

    expect(second.status).toBe(200);
    expect(second.body.emergencyPlan.body).toContain('three minutes');

    const [{ count }] = await h.ownerDb.execute<{ count: string }>(
      sql`select count(*)::text as count from emergency_plans`,
    );
    expect(count).toBe('1');
  });

  it('lets a worker in scope read the plan but not write it', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const created = await adminApi.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    await adminApi
      .put(`/api/v1/participants/${id}/emergency-plan`)
      .send({ title: 'Seizure response', body: 'Call 000 if longer than five minutes.' });

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, id);
    const workerApi = as(await signIn(h, worker));

    const read = await workerApi.get(`/api/v1/participants/${id}/emergency-plan`);
    expect(read.status).toBe(200);
    expect(read.body.emergencyPlan.body).toContain('Call 000');

    const write = await workerApi
      .put(`/api/v1/participants/${id}/emergency-plan`)
      .send({ title: 'Changed', body: 'Changed' });
    expect(write.status).toBe(403);
  });
});

describe('scope on the Phase 2 routes', () => {
  it('denies every participant route to a worker out of scope', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const created = await adminApi.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    const mine = await seedParticipant(h.ownerDb, h.keyRing);
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, mine);
    const api = as(await signIn(h, worker));

    for (const path of [
      `/api/v1/participants/${id}`,
      `/api/v1/participants/${id}/alerts`,
      `/api/v1/participants/${id}/contacts`,
      `/api/v1/participants/${id}/emergency-plan`,
    ]) {
      const response = await api.get(path);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe('scope_denied');
    }
  });

  it('checks scope before capability, so a denial never depends on the role', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const created = await adminApi.post('/api/v1/participants').send(alice);
    const id = created.body.participant.id;

    // A nurse may edit alerts, but not for someone outside their scope. The
    // answer has to be the same one a worker gets.
    const nurse = await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' });
    const nurseApi = as(await signIn(h, nurse));

    const response = await nurseApi
      .post(`/api/v1/participants/${id}/alerts`)
      .send({ kind: 'other', severity: 'info', text: 'x' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('scope_denied');
  });

  it('shows a worker only their own people in the list', async () => {
    const { api: adminApi } = await signInAsAdmin();
    const mine = await adminApi.post('/api/v1/participants').send(alice);
    await adminApi
      .post('/api/v1/participants')
      .send({ ...alice, firstName: 'Jack', lastName: 'Nguyen', ndisNumber: '431234568' });

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, mine.body.participant.id);
    const api = as(await signIn(h, worker));

    const listed = await api.get('/api/v1/participants');
    expect(listed.body.participants).toHaveLength(1);
    expect(listed.body.participants[0].firstName).toBe('Alice');
  });
});
