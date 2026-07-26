import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createHarness,
  currentTotpCode,
  resetData,
  seedUser,
  signIn,
  TEST_PASSWORD,
  type Harness,
} from './helpers.js';

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

describe('sign-in', () => {
  it('rejects a wrong password without saying which part was wrong', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitely not the password' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('That email or password is not correct.');
  });

  it('gives an unknown email exactly the same answer as a wrong password', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const unknown = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.org', password: 'definitely not the password' });
    const wrong = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitely not the password' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('refuses a suspended account without saying it is suspended', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker', status: 'suspended' });

    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('That email or password is not correct.');
  });

  it('sets an httpOnly session cookie and a readable CSRF cookie', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('vigilo_session='));
    const csrf = cookies.find((c) => c.startsWith('vigilo_csrf='));

    expect(session).toBeDefined();
    expect(session!.toLowerCase()).toContain('httponly');

    // The SPA has to read this one to echo it back as a header, so it is
    // deliberately not httpOnly. That is what makes double-submit work.
    expect(csrf).toBeDefined();
    expect(csrf!.toLowerCase()).not.toContain('httponly');
  });

  it('never returns the password hash', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(res.body.principal.passwordHash).toBeUndefined();
  });
});

describe('lockout', () => {
  it('locks after the configured number of failures and then refuses the right password', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    for (let i = 0; i < 10; i += 1) {
      await request(h.app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'wrong one' });
    }

    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
  });

  it('clears the counter after a successful sign-in', async () => {
    const user = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    for (let i = 0; i < 3; i += 1) {
      await request(h.app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'wrong one' });
    }
    await signIn(h, user);

    const [row] = await h.ownerDb.execute<{ failed_attempts: number }>(
      sql`select failed_attempts from users where id = ${user.id}::uuid`,
    );
    expect(Number(row!.failed_attempts)).toBe(0);
  });
});

describe('two-factor', () => {
  it('issues a challenge instead of a session when enrolled', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });

    expect(res.body.result).toBe('totp_required');
    expect(res.body.challengeId).toBeTruthy();
    // Nothing usable is issued before the second factor is satisfied.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a wrong code', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });

    const res = await request(h.app)
      .post('/api/v1/auth/totp')
      .send({ challengeId: login.body.challengeId, code: '000000' });

    expect(res.status).toBe(401);
  });

  it('refuses to reuse a challenge', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });

    const code = currentTotpCode(admin.totpSecret!);
    const first = await request(h.app)
      .post('/api/v1/auth/totp')
      .send({ challengeId: login.body.challengeId, code });
    expect(first.status).toBe(200);

    const second = await request(h.app)
      .post('/api/v1/auth/totp')
      .send({ challengeId: login.body.challengeId, code });
    expect(second.status).toBe(401);
  });

  it('accepts a recovery code once and not twice', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin', totpEnabled: false });

    // Enrol properly so real recovery codes exist.
    const { cookies, csrfToken } = await signIn(h, admin);
    const enrol = await request(h.app)
      .post('/api/v1/auth/totp/enrol')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken);
    expect(enrol.status).toBe(200);

    const secret = enrol.body.secret as string;
    const recovery = enrol.body.recoveryCodes[0] as string;

    await request(h.app)
      .post('/api/v1/auth/totp/confirm')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ code: currentTotpCode(secret) });

    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect(login.body.result).toBe('totp_required');

    const used = await request(h.app)
      .post('/api/v1/auth/recovery-code')
      .send({ challengeId: login.body.challengeId, code: recovery });
    expect(used.status).toBe(200);

    const again = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: admin.password });
    const reused = await request(h.app)
      .post('/api/v1/auth/recovery-code')
      .send({ challengeId: again.body.challengeId, code: recovery });
    expect(reused.status).toBe(401);
  });

  it('stores the TOTP secret encrypted, not in the clear', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });

    const [row] = await h.ownerDb.execute<{ totp_secret_enc: Buffer }>(
      sql`select totp_secret_enc from users where id = ${admin.id}::uuid`,
    );
    const stored = Buffer.from(row!.totp_secret_enc);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.toString('utf8')).not.toContain(admin.totpSecret!);
  });
});

describe('accounts with an outstanding requirement', () => {
  it('blocks everything else until the password is changed', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, {
      role: 'worker',
      mustChangePassword: true,
    });
    const { cookies } = await signIn(h, worker);

    const res = await request(h.app).get('/api/v1/participants').set('Cookie', cookies);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('password_change_required');
  });

  it('blocks an admin who has not enrolled in two-factor', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin', totpEnabled: false });
    const { cookies } = await signIn(h, admin);

    const res = await request(h.app).get('/api/v1/users').set('Cookie', cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('totp_required');
  });

  it('lets the account through once it changes its password', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, {
      role: 'worker',
      mustChangePassword: true,
    });
    const { cookies, csrfToken } = await signIn(h, worker);

    const change = await request(h.app)
      .post('/api/v1/auth/password')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a brand new long passphrase' });
    expect(change.status).toBe(204);

    const after = await signIn(h, { ...worker, password: 'a brand new long passphrase' });
    const res = await request(h.app).get('/api/v1/participants').set('Cookie', after.cookies);
    expect(res.status).toBe(200);
  });

  it('refuses a new password that fails the policy', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, {
      role: 'worker',
      mustChangePassword: true,
    });
    const { cookies, csrfToken } = await signIn(h, worker);

    const res = await request(h.app)
      .post('/api/v1/auth/password')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('signs every other session out after a password change', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const first = await signIn(h, worker);
    const second = await signIn(h, worker);

    await request(h.app)
      .post('/api/v1/auth/password')
      .set('Cookie', second.cookies)
      .set('x-csrf-token', second.csrfToken)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'another long enough passphrase' });

    const res = await request(h.app).get('/api/v1/participants').set('Cookie', first.cookies);
    expect(res.status).toBe(401);
  });
});

describe('CSRF', () => {
  it('refuses a cookie-authenticated mutation with no CSRF header', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies } = await signIn(h, admin);

    const res = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .send({ email: 'new@example.org', displayName: 'New Person', role: 'worker' });

    expect(res.status).toBe(422);
  });

  it('refuses a mismatched CSRF header', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies } = await signIn(h, admin);

    const res = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', 'not the right token')
      .send({ email: 'new@example.org', displayName: 'New Person', role: 'worker' });

    expect(res.status).toBe(422);
  });

  it('does not apply to reads', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies } = await signIn(h, admin);

    const res = await request(h.app).get('/api/v1/users').set('Cookie', cookies);
    expect(res.status).toBe(200);
  });
});

describe('installed-app tokens', () => {
  async function appSignIn(user: Awaited<ReturnType<typeof seedUser>>) {
    const deviceId = randomUUID();
    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password, deviceId, platform: 'android' });

    if (login.body.result === 'totp_required') {
      return request(h.app)
        .post('/api/v1/auth/totp')
        .send({ challengeId: login.body.challengeId, code: currentTotpCode(user.totpSecret!) });
    }
    return login;
  }

  it('returns tokens in the body rather than a cookie', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const res = await appSignIn(worker);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('authenticates with a bearer token, and needs no CSRF header', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const res = await appSignIn(admin);

    const list = await request(h.app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${res.body.accessToken as string}`);
    expect(list.status).toBe(200);
  });

  it('rotates the refresh token', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const first = await appSignIn(worker);

    const refreshed = await request(h.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(first.body.refreshToken);
  });

  it('revokes the whole family when a used refresh token is replayed', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const first = await appSignIn(worker);

    const second = await request(h.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });
    expect(second.status).toBe(200);

    // A captured token being replayed.
    const replay = await request(h.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });
    expect(replay.status).toBe(401);

    // The legitimate holder's newer token is revoked too, because at this
    // point we cannot tell which party is the attacker.
    const afterRevoke = await request(h.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken });
    expect(afterRevoke.status).toBe(401);

    // Exactly one theft report. The legitimate holder's now-revoked token is
    // recorded separately, so a single capture does not look like two.
    const reuse = await h.ownerDb.execute<{ action: string }>(
      sql`select action from audit_log where action = 'auth.refresh_reuse_detected'`,
    );
    expect(reuse).toHaveLength(1);

    const revoked = await h.ownerDb.execute<{ action: string }>(
      sql`select action from audit_log where action = 'auth.refresh_revoked'`,
    );
    expect(revoked).toHaveLength(1);
  });
});

describe('sign-out', () => {
  it('invalidates the session', async () => {
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });
    const { cookies, csrfToken } = await signIn(h, worker);

    await request(h.app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .expect(204);

    const res = await request(h.app).get('/api/v1/participants').set('Cookie', cookies);
    expect(res.status).toBe(401);
  });
});

describe('suspension takes effect immediately', () => {
  it('kills a live session and flags the devices for wipe', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const worker = await seedUser(h.ownerDb, h.keyRing, { role: 'worker' });

    const workerSession = await signIn(h, worker);
    expect(
      (await request(h.app).get('/api/v1/participants').set('Cookie', workerSession.cookies))
        .status,
    ).toBe(200);

    const adminSession = await signIn(h, admin);
    const suspend = await request(h.app)
      .post(`/api/v1/users/${worker.id}/suspend`)
      .set('Cookie', adminSession.cookies)
      .set('x-csrf-token', adminSession.csrfToken);
    expect(suspend.status).toBe(200);

    const after = await request(h.app)
      .get('/api/v1/participants')
      .set('Cookie', workerSession.cookies);
    expect(after.status).toBe(401);
  });

  it('will not let an admin suspend themselves', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    const res = await request(h.app)
      .post(`/api/v1/users/${admin.id}/suspend`)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken);

    expect(res.status).toBe(409);
  });
});

describe('admin-issued credentials', () => {
  it('returns a one-time password once and forces a change at first sign-in', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    const created = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ email: 'newworker@example.org', displayName: 'New Worker', role: 'worker' });

    expect(created.status).toBe(201);
    const oneTimePassword = created.body.oneTimePassword as string;
    expect(oneTimePassword).toBeTruthy();
    expect(created.body.user.mustChangePassword).toBe(true);

    const login = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ email: 'newworker@example.org', password: oneTimePassword });
    expect(login.status).toBe(200);
    expect(login.body.principal.mustChangePassword).toBe(true);
  });

  it('refuses a duplicate email', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    const body = { email: 'dupe@example.org', displayName: 'First', role: 'worker' };
    await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send(body);

    const second = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send(body);

    expect(second.status).toBe(409);
  });

  it('treats email as case-insensitive', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ email: 'MixedCase@Example.org', displayName: 'Mixed', role: 'worker' });

    const second = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ email: 'mixedcase@example.org', displayName: 'Mixed again', role: 'worker' });

    expect(second.status).toBe(409);
  });

  it('refuses a participant account with no participant', async () => {
    const admin = await seedUser(h.ownerDb, h.keyRing, { role: 'admin' });
    const { cookies, csrfToken } = await signIn(h, admin);

    const res = await request(h.app)
      .post('/api/v1/users')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrfToken)
      .send({ email: 'selfaccess@example.org', displayName: 'Self', role: 'participant' });

    expect(res.status).toBe(422);
  });
});
