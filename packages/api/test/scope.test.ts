import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { Role } from '@vigilo/shared';
import {
  addTeamScope,
  assign,
  createHarness,
  resetData,
  seedParticipant,
  seedUser,
  signIn,
  type Harness,
} from './helpers.js';

/**
 * The roadmap's Phase 1 acceptance bar: an integration test per role proving
 * that an out-of-scope request is denied.
 *
 * Denied means `scope_denied`, not a 404. A not-found would leak whether the
 * participant exists (doc 07 §3).
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

describe('out-of-scope access is denied for every role', () => {
  const cases: { role: Role; grant: 'assignment' | 'team_scope' | 'none' }[] = [
    { role: 'worker', grant: 'assignment' },
    { role: 'team_leader', grant: 'team_scope' },
    { role: 'nurse', grant: 'team_scope' },
  ];

  for (const { role, grant } of cases) {
    it(`denies a ${role} a participant outside their scope`, async () => {
      const inScope = await seedParticipant(h.ownerDb, h.keyRing);
      const outOfScope = await seedParticipant(h.ownerDb, h.keyRing);

      const user = await seedUser(h.ownerDb, h.keyRing, { role });

      if (grant === 'assignment') await assign(h.ownerDb, user.id, inScope);
      if (grant === 'team_scope') await addTeamScope(h.ownerDb, user.id, inScope);

      const { cookies } = await signIn(h, user);

      const allowed = await request(h.app)
        .get(`/api/v1/participants/${inScope}`)
        .set('Cookie', cookies);
      expect(allowed.status).toBe(200);

      const denied = await request(h.app)
        .get(`/api/v1/participants/${outOfScope}`)
        .set('Cookie', cookies);

      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('scope_denied');
    });
  }

  /**
   * A self-access account is the one role scope alone does not decide.
   *
   * It is in scope for its own record, so the staff route would answer 200
   * about them. Since Phase 9 the role is refused the whole staff surface
   * (D70) and reads its own record through `/me`, so this is what "in scope"
   * and "out of scope" mean for a participant.
   */
  it('denies a participant every participant record, including their own', async () => {
    const own = await seedParticipant(h.ownerDb, h.keyRing);
    const somebodyElse = await seedParticipant(h.ownerDb, h.keyRing);

    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'participant', participantId: own });
    const { cookies } = await signIn(h, user);

    for (const id of [own, somebodyElse]) {
      const response = await request(h.app)
        .get(`/api/v1/participants/${id}`)
        .set('Cookie', cookies);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('scope_denied');
    }

    const mine = await request(h.app).get('/api/v1/me/day').set('Cookie', cookies);
    expect(mine.status).toBe(200);
  });

  it('gives an admin every participant', async () => {
    const a = await seedParticipant(h.ownerDb, h.keyRing);
    const b = await seedParticipant(h.ownerDb, h.keyRing);
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    const { cookies } = await signIn(h, admin);

    for (const id of [a, b]) {
      const res = await request(h.app).get(`/api/v1/participants/${id}`).set('Cookie', cookies);
      expect(res.status).toBe(200);
    }
  });

  it('denies rather than 404s for a participant that does not exist', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const { cookies } = await signIn(h, worker);

    const res = await request(h.app)
      .get('/api/v1/participants/00000000-0000-4000-8000-000000000000')
      .set('Cookie', cookies);

    // The same answer as an out-of-scope real participant, so the response
    // cannot be used to probe for existence.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('scope_denied');
  });

  it('drops access when a temporary grant expires', async () => {
    const participantId = await seedParticipant(h.ownerDb, h.keyRing);
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    await assign(h.ownerDb, worker.id, participantId, {
      kind: 'temporary',
      expiresAt: new Date(Date.now() - 1000),
      reason: 'covered a shift yesterday',
    });

    const { cookies } = await signIn(h, worker);
    const res = await request(h.app)
      .get(`/api/v1/participants/${participantId}`)
      .set('Cookie', cookies);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('scope_denied');
  });

  it('drops access when an assignment is revoked', async () => {
    const participantId = await seedParticipant(h.ownerDb, h.keyRing);
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, participantId);

    const { cookies: before } = await signIn(h, worker);
    expect(
      (await request(h.app).get(`/api/v1/participants/${participantId}`).set('Cookie', before))
        .status,
    ).toBe(200);

    await h.ownerDb.execute(sql`update participant_assignments set revoked_at = now()`);

    const after = await request(h.app)
      .get(`/api/v1/participants/${participantId}`)
      .set('Cookie', before);
    expect(after.status).toBe(403);
  });
});

describe('the scoped list', () => {
  it('returns only what each role may see', async () => {
    const mine = await seedParticipant(h.ownerDb, h.keyRing);
    await seedParticipant(h.ownerDb, h.keyRing);

    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    await assign(h.ownerDb, worker.id, mine);

    const { cookies } = await signIn(h, worker);
    const res = await request(h.app).get('/api/v1/participants').set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.participants).toHaveLength(1);
    expect(res.body.participants[0].id).toBe(mine);
  });

  it('is empty, not an error, for someone with no assignments', async () => {
    await seedParticipant(h.ownerDb, h.keyRing);
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const { cookies } = await signIn(h, worker);
    const res = await request(h.app).get('/api/v1/participants').set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.participants).toEqual([]);
  });
});

describe('user administration is admin only', () => {
  const nonAdmins: Role[] = ['team_leader', 'nurse', 'worker', 'participant'];

  for (const role of nonAdmins) {
    it(`denies a ${role} the user list`, async () => {
      const participantId =
        role === 'participant' ? await seedParticipant(h.ownerDb, h.keyRing) : null;
      const user = await seedUser(h.ownerDb, h.keyRing, { role, participantId });
      const { cookies } = await signIn(h, user);

      const res = await request(h.app).get('/api/v1/users').set('Cookie', cookies);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('scope_denied');
    });
  }

  it('allows an admin', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies } = await signIn(h, admin);

    const res = await request(h.app).get('/api/v1/users').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

describe('unauthenticated access', () => {
  it('is refused without a session', async () => {
    const res = await request(h.app).get('/api/v1/participants');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
});
