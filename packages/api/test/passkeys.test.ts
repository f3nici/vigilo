import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { deviceCredentials, webauthnCredentials } from '../src/db/schema.js';
import { createHarness, resetData, seedUser, signIn, type Harness } from './helpers.js';
import { TestAuthenticator } from './authenticator.js';

/**
 * Passkeys and quick sign-in (#24).
 *
 * Driven through the real routes with a software authenticator, because the
 * whole value of this feature is that the server accepts a signature it should
 * and refuses one it should not, and nothing short of running both proves it.
 */

let h: Harness;

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:8081';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetData(h.ownerDb);
});

type SignedIn = Awaited<ReturnType<typeof signIn>>;

async function registrationChallenge(session: SignedIn): Promise<string> {
  const res = await request(h.app)
    .post('/api/v1/auth/passkeys/options')
    .set('Cookie', session.cookies)
    .set('x-csrf-token', session.csrfToken);

  expect(res.status).toBe(200);
  return res.body.options.challenge as string;
}

async function signInChallenge(): Promise<string> {
  const res = await request(h.app).post('/api/v1/auth/passkey/options').send({});
  expect(res.status).toBe(200);
  return res.body.options.challenge as string;
}

/** Registers one, the way the screen does: options, prompt, then the response. */
async function addPasskey(
  session: SignedIn,
  authenticator = new TestAuthenticator(),
  name = 'My phone',
): Promise<TestAuthenticator> {
  const challenge = await registrationChallenge(session);

  const res = await request(h.app)
    .post('/api/v1/auth/passkeys')
    .set('Cookie', session.cookies)
    .set('x-csrf-token', session.csrfToken)
    .send({ name, credential: authenticator.register({ challenge, rpId: RP_ID, origin: ORIGIN }) });

  expect(res.status).toBe(201);
  return authenticator;
}

describe('passkeys', () => {
  it('registers one and then signs in with it, with no password and no code', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const authenticator = await addPasskey(session, new TestAuthenticator(), 'Ana phone');

    const challenge = await signInChallenge();
    const res = await request(h.app)
      .post('/api/v1/auth/passkey/login')
      .send({ credential: authenticator.authenticate({ challenge, rpId: RP_ID, origin: ORIGIN }) });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('authenticated');
    expect(res.body.principal.userId).toBe(user.id);
    // A session cookie, exactly as a password sign-in in a browser tab gets.
    expect(res.headers['set-cookie'].join(';')).toContain('vigilo_session');
  });

  it('signs a team leader in without the second factor, because it is one', async () => {
    // A role that must have TOTP. The passkey ceremony is possession and
    // verification together, so there is no challenge step (doc 01 §10).
    const lead = await seedUser(h.ownerDb, h.keyRing, { role: 'team_leader' });
    const session = await signIn(h, lead);
    const authenticator = await addPasskey(session);

    const challenge = await signInChallenge();
    const res = await request(h.app)
      .post('/api/v1/auth/passkey/login')
      .send({ credential: authenticator.authenticate({ challenge, rpId: RP_ID, origin: ORIGIN }) });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('authenticated');
  });

  it('refuses an authenticator that did not verify the person', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);

    // Registration itself is refused: a credential that never verifies would
    // sign somebody in from a stolen unlocked laptop.
    const challenge = await registrationChallenge(session);
    const res = await request(h.app)
      .post('/api/v1/auth/passkeys')
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken)
      .send({
        name: 'Careless key',
        credential: new TestAuthenticator({ verifies: false }).register({
          challenge,
          rpId: RP_ID,
          origin: ORIGIN,
        }),
      });

    expect(res.status).toBe(422);
  });

  it('refuses a challenge that has already been answered', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const authenticator = await addPasskey(session);

    const challenge = await signInChallenge();
    const credential = authenticator.authenticate({ challenge, rpId: RP_ID, origin: ORIGIN });

    const first = await request(h.app).post('/api/v1/auth/passkey/login').send({ credential });
    expect(first.status).toBe(200);

    // The same bytes again. A replayed ceremony is the attack a stored,
    // single-use challenge exists to stop.
    const second = await request(h.app).post('/api/v1/auth/passkey/login').send({ credential });
    expect(second.status).toBe(401);
  });

  it('refuses a signature made for another site', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const authenticator = await addPasskey(session);

    const challenge = await signInChallenge();
    const res = await request(h.app)
      .post('/api/v1/auth/passkey/login')
      .send({
        credential: authenticator.authenticate({
          challenge,
          rpId: 'not-vigilo.example',
          origin: 'https://not-vigilo.example',
        }),
      });

    expect(res.status).toBe(401);
  });

  it('refuses a credential nobody registered, in the same words', async () => {
    const challenge = await signInChallenge();
    const res = await request(h.app)
      .post('/api/v1/auth/passkey/login')
      .send({
        credential: new TestAuthenticator().authenticate({
          challenge,
          rpId: RP_ID,
          origin: ORIGIN,
        }),
      });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(
      'That passkey did not work. Sign in with your password instead.',
    );
  });

  it('stops working once it is removed, and the row is kept', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const authenticator = await addPasskey(session);

    const list = await request(h.app).get('/api/v1/auth/passkeys').set('Cookie', session.cookies);
    expect(list.body.passkeys).toHaveLength(1);
    expect(list.body.passkeys[0].syncedAcrossDevices).toBe(true);

    const removed = await request(h.app)
      .delete(`/api/v1/auth/passkeys/${list.body.passkeys[0].id}`)
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken);
    expect(removed.status).toBe(204);

    const challenge = await signInChallenge();
    const res = await request(h.app)
      .post('/api/v1/auth/passkey/login')
      .send({ credential: authenticator.authenticate({ challenge, rpId: RP_ID, origin: ORIGIN }) });
    expect(res.status).toBe(401);

    // Which credentials an account had, and when they stopped working, is
    // exactly what somebody has to be able to answer later.
    const rows = await h.ownerDb
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('needs a session to register one', async () => {
    const res = await request(h.app).post('/api/v1/auth/passkeys/options');
    expect(res.status).toBe(401);
  });
});

describe('quick sign-in', () => {
  async function enrol(session: SignedIn, method: 'pin' | 'biometric' = 'pin') {
    const res = await request(h.app)
      .post('/api/v1/auth/quick-sign-in/enrol')
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken)
      .send({ method, label: 'Ana phone' });

    expect(res.status).toBe(201);
    const { credentialId, secret } = res.body.credential as {
      credentialId: string;
      secret: string;
    };
    // Only the two fields the device keeps. The expiry is for the screen, and
    // the route is strict about what it is sent.
    return { credentialId, secret };
  }

  it('signs in with the secret this device is holding', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const credential = await enrol(await signIn(h, user));

    const res = await request(h.app).post('/api/v1/auth/quick-sign-in').send(credential);

    expect(res.status).toBe(200);
    expect(res.body.principal.userId).toBe(user.id);
  });

  it('retires the credential the moment a wrong secret is presented', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const credential = await enrol(await signIn(h, user));

    const wrong = await request(h.app)
      .post('/api/v1/auth/quick-sign-in')
      .send({ credentialId: credential.credentialId, secret: 'not the secret' });
    expect(wrong.status).toBe(401);

    // The device either unseals the right secret or it does not, so a wrong
    // one is not a typo to count: it is somebody guessing.
    const right = await request(h.app).post('/api/v1/auth/quick-sign-in').send(credential);
    expect(right.status).toBe(401);
  });

  it('is replaced rather than added to when the same device sets it up again', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const device = '11111111-2222-4333-8444-555555555555';

    const first = await request(h.app)
      .post('/api/v1/auth/quick-sign-in/enrol')
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken)
      .set('x-device-id', device)
      .send({ method: 'pin', label: 'Ana phone' });

    const second = await request(h.app)
      .post('/api/v1/auth/quick-sign-in/enrol')
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken)
      .set('x-device-id', device)
      .send({ method: 'biometric', label: 'Ana phone' });

    expect(second.status).toBe(201);

    const list = await request(h.app)
      .get('/api/v1/auth/quick-sign-in')
      .set('Cookie', session.cookies);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].method).toBe('biometric');

    const stale = await request(h.app).post('/api/v1/auth/quick-sign-in').send({
      credentialId: first.body.credential.credentialId,
      secret: first.body.credential.secret,
    });
    expect(stale.status).toBe(401);
  });

  it('stops working when the person changes their password', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const credential = await enrol(session);

    const changed = await request(h.app)
      .post('/api/v1/auth/password')
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken)
      .send({ currentPassword: user.password, newPassword: 'a much longer new passphrase' });
    expect(changed.status).toBe(204);

    // Somebody changing their password because they think it is known must
    // not leave a phone able to walk straight in.
    const res = await request(h.app).post('/api/v1/auth/quick-sign-in').send(credential);
    expect(res.status).toBe(401);
  });

  it('refuses one belonging to a suspended account', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const credential = await enrol(await signIn(h, user));

    // Suspension is instant everywhere, and this is one of the everywheres.
    await h.ownerDb.execute(sql`update users set status = 'suspended' where id = ${user.id}`);

    const res = await request(h.app).post('/api/v1/auth/quick-sign-in').send(credential);
    expect(res.status).toBe(401);
  });

  it('is removed from the list and refused afterwards', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const session = await signIn(h, user);
    const credential = await enrol(session);

    const removed = await request(h.app)
      .delete(`/api/v1/auth/quick-sign-in/${credential.credentialId}`)
      .set('Cookie', session.cookies)
      .set('x-csrf-token', session.csrfToken);
    expect(removed.status).toBe(204);

    const res = await request(h.app).post('/api/v1/auth/quick-sign-in').send(credential);
    expect(res.status).toBe(401);

    const rows = await h.ownerDb
      .select()
      .from(deviceCredentials)
      .where(eq(deviceCredentials.userId, user.id));
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('needs a session to set one up', async () => {
    const res = await request(h.app)
      .post('/api/v1/auth/quick-sign-in/enrol')
      .send({ method: 'pin', label: 'Somebody phone' });

    expect(res.status).toBe(401);
  });
});
