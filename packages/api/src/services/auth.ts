import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  checkPassword,
  passwordProblemMessages,
  totpRequired,
  type LoginRequest,
  type Platform,
  type Principal,
  type Role,
  type UserStatus,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  authChallenges,
  devices,
  recoveryCodes,
  refreshTokens,
  sessions,
  users,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, encryptField } from '../crypto/fields.js';
import {
  generateRecoveryCode,
  generateToken,
  hashPassword,
  hashToken,
  normaliseRecoveryCode,
  verifyPassword,
} from '../crypto/passwords.js';
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from './totp.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';
import type { Config } from '../config.js';

export const TOTP_SECRET_COLUMN = 'users.totp_secret_enc';

/**
 * A dummy hash, verified against when the email is unknown so that a request
 * for a non-existent account costs the same as one for a real account. Without
 * it, response timing enumerates users.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR0aGF0aXNsb25n$8Fk5vJ3fY1lKQxq0rP0bJm1n2o3p4q5r6s7t8u9v0w0';

export type AuthContext = {
  db: Database;
  config: Config;
  keyRing: KeyRing;
};

export type UserRow = typeof users.$inferSelect;

export function toPrincipal(user: UserRow): Principal {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    participantId: user.participantId,
    mustChangePassword: user.mustChangePassword,
    totpEnabled: user.totpEnabledAt !== null,
    totpRequired: totpRequired(user.role),
  };
}

/**
 * Whether the account still has something it must do before it can be used
 * for anything else (doc 01 §10). The middleware turns this into a
 * `password_change_required` or `totp_required` error on every other route.
 */
export function pendingRequirement(
  user: Pick<UserRow, 'mustChangePassword' | 'role' | 'totpEnabledAt'>,
): 'password_change_required' | 'totp_required' | null {
  if (user.mustChangePassword) return 'password_change_required';
  if (totpRequired(user.role) && user.totpEnabledAt === null) return 'totp_required';
  return null;
}

function assertUsable(status: UserStatus): void {
  if (status !== 'active') {
    // Same message either way. Whether an account is suspended or archived is
    // not something an unauthenticated caller learns.
    throw new HttpError('unauthenticated', 'That email or password is not correct.');
  }
}

async function findByEmail(db: Database, email: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user ?? null;
}

export async function findById(db: Database, userId: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

async function registerFailure(ctx: AuthContext, user: UserRow, actor: AuditActor): Promise<void> {
  const attempts = user.failedAttempts + 1;
  const shouldLock = attempts >= ctx.config.MAX_FAILED_ATTEMPTS;

  await ctx.db
    .update(users)
    .set({
      failedAttempts: attempts,
      lockedUntil: shouldLock
        ? new Date(Date.now() + ctx.config.LOCKOUT_MINUTES * 60_000)
        : user.lockedUntil,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  await recordAudit(ctx.db, {
    action: shouldLock ? 'auth.locked' : 'auth.login_failed',
    actor,
    entityType: 'user',
    entityId: user.id,
    metadata: { attempts },
  });
}

async function clearFailures(ctx: AuthContext, userId: string): Promise<void> {
  await ctx.db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export type LoginOutcome =
  { result: 'authenticated'; user: UserRow } | { result: 'totp_required'; challengeId: string };

/**
 * Verifies email and password, then either completes or issues a second-factor
 * challenge. No token of any kind is issued before TOTP is satisfied for a role
 * that requires it (doc 02 §5).
 */
export async function login(
  ctx: AuthContext,
  request: LoginRequest,
  actor: AuditActor,
): Promise<LoginOutcome> {
  const user = await findByEmail(ctx.db, request.email);

  if (!user) {
    // Spend the same time as a real verification so timing does not enumerate.
    await verifyPassword(DUMMY_HASH, request.password);
    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor,
      metadata: { reason: 'unknown_email' },
    });
    throw new HttpError('unauthenticated', 'That email or password is not correct.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor,
      entityType: 'user',
      entityId: user.id,
      metadata: { reason: 'locked' },
    });
    throw new HttpError(
      'rate_limited',
      'This account is locked after too many attempts. Try again later or ask an admin.',
    );
  }

  assertUsable(user.status);

  if (!(await verifyPassword(user.passwordHash, request.password))) {
    await registerFailure(ctx, user, actor);
    throw new HttpError('unauthenticated', 'That email or password is not correct.');
  }

  // Password is right. A wrong second factor from here is tracked separately.
  if (user.totpEnabledAt !== null) {
    if (user.totpSecretEnc === null) {
      // Enrolled with no secret should be impossible. If it happens, refuse
      // rather than quietly falling back to password-only.
      throw new HttpError(
        'unauthenticated',
        'Two-factor authentication is not set up correctly on this account. Ask an admin to reset it.',
      );
    }
    const challengeId = await issueChallenge(ctx, user, request);
    return { result: 'totp_required', challengeId };
  }

  await clearFailures(ctx, user.id);
  await recordAudit(ctx.db, {
    action: 'auth.login',
    actor,
    entityType: 'user',
    entityId: user.id,
    metadata: { secondFactor: false },
  });

  return { result: 'authenticated', user };
}

const CHALLENGE_TTL_MS = 5 * 60_000;

async function issueChallenge(
  ctx: AuthContext,
  user: UserRow,
  request: LoginRequest,
): Promise<string> {
  const token = generateToken(24);

  await ctx.db.insert(authChallenges).values({
    userId: user.id,
    tokenHash: hashToken(token),
    deviceId: request.deviceId ?? null,
    platform: request.platform ?? null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return token;
}

type ChallengeRow = typeof authChallenges.$inferSelect;

async function consumeChallenge(ctx: AuthContext, challengeId: string): Promise<ChallengeRow> {
  const [challenge] = await ctx.db
    .select()
    .from(authChallenges)
    .where(
      and(eq(authChallenges.tokenHash, hashToken(challengeId)), isNull(authChallenges.consumedAt)),
    )
    .limit(1);

  if (!challenge || challenge.expiresAt <= new Date()) {
    throw new HttpError('unauthenticated', 'That sign-in attempt has expired. Start again.');
  }

  return challenge;
}

async function markChallengeUsed(ctx: AuthContext, id: string): Promise<void> {
  await ctx.db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(authChallenges.id, id));
}

/** Completes a login challenge with a TOTP code. */
export async function completeTotpChallenge(
  ctx: AuthContext,
  challengeId: string,
  code: string,
  actor: AuditActor,
): Promise<{ user: UserRow; challenge: ChallengeRow }> {
  const challenge = await consumeChallenge(ctx, challengeId);
  const user = await findById(ctx.db, challenge.userId);
  if (!user || user.totpSecretEnc === null) {
    throw new HttpError('unauthenticated', 'That sign-in attempt has expired. Start again.');
  }

  assertUsable(user.status);

  const secret = decryptField(ctx.keyRing, TOTP_SECRET_COLUMN, user.totpSecretEnc);
  if (!verifyTotp(secret, code)) {
    await registerFailure(ctx, user, { ...actor, userId: user.id });
    throw new HttpError('unauthenticated', 'That code is not correct.');
  }

  await markChallengeUsed(ctx, challenge.id);
  await clearFailures(ctx, user.id);
  await recordAudit(ctx.db, {
    action: 'auth.login',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    metadata: { secondFactor: 'totp' },
  });

  return { user, challenge };
}

/** Completes a login challenge with a single-use recovery code. */
export async function completeRecoveryChallenge(
  ctx: AuthContext,
  challengeId: string,
  code: string,
  actor: AuditActor,
): Promise<{ user: UserRow; challenge: ChallengeRow }> {
  const challenge = await consumeChallenge(ctx, challengeId);
  const user = await findById(ctx.db, challenge.userId);
  if (!user)
    throw new HttpError('unauthenticated', 'That sign-in attempt has expired. Start again.');

  assertUsable(user.status);

  const candidates = await ctx.db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)));

  const wanted = hashToken(normaliseRecoveryCode(code));
  const match = candidates.find((row) => row.codeHash === wanted);

  if (!match) {
    await registerFailure(ctx, user, { ...actor, userId: user.id });
    throw new HttpError('unauthenticated', 'That recovery code is not correct.');
  }

  await ctx.db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(recoveryCodes.id, match.id));
  await markChallengeUsed(ctx, challenge.id);
  await clearFailures(ctx, user.id);

  const remaining = candidates.length - 1;
  await recordAudit(ctx.db, {
    action: 'auth.login',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    metadata: { secondFactor: 'recovery_code', remainingCodes: remaining },
  });

  return { user, challenge };
}

/** Sets a new password, clearing the forced-change flag. */
export async function changePassword(
  ctx: AuthContext,
  user: UserRow,
  currentPassword: string,
  newPassword: string,
  actor: AuditActor,
): Promise<void> {
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new HttpError('unauthenticated', 'Your current password is not correct.');
  }

  const problems = checkPassword({
    password: newPassword,
    email: user.email,
    currentPassword,
  });

  if (problems.length > 0) {
    throw new HttpError(
      'validation_failed',
      problems.map((p) => passwordProblemMessages[p]).join(' '),
      {
        problems,
      },
    );
  }

  await ctx.db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      updatedAt: new Date(),
      revision: sql`${users.revision} + 1`,
    })
    .where(eq(users.id, user.id));

  await recordAudit(ctx.db, {
    action: 'auth.password_changed',
    actor,
    entityType: 'user',
    entityId: user.id,
  });
}

// ---------------------------------------------------------------------------
// Web sessions (office use in a plain browser tab)
// ---------------------------------------------------------------------------

export type IssuedSession = {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
};

export async function createSession(
  ctx: AuthContext,
  userId: string,
  idleMinutes: number,
  meta: { ip: string | null; userAgent: string | null },
): Promise<IssuedSession> {
  const sessionToken = generateToken();
  const csrfToken = generateToken(24);
  const expiresAt = new Date(Date.now() + idleMinutes * 60_000);

  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: hashToken(sessionToken),
    csrfTokenHash: hashToken(csrfToken),
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { sessionToken, csrfToken, expiresAt };
}

export type ActiveSession = typeof sessions.$inferSelect;

export async function findActiveSession(
  db: Database,
  sessionToken: string,
): Promise<ActiveSession | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session || session.expiresAt <= new Date()) return null;
  return session;
}

/** Sliding idle expiry, so an active user is not signed out mid-shift. */
export async function touchSession(
  db: Database,
  sessionId: string,
  idleMinutes: number,
): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + idleMinutes * 60_000) })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

// ---------------------------------------------------------------------------
// Installed-app tokens (rotating refresh, short-lived access)
// ---------------------------------------------------------------------------

export type IssuedTokens = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
};

export async function registerDevice(
  ctx: AuthContext,
  userId: string,
  deviceId: string,
  platform: Platform,
): Promise<void> {
  await ctx.db
    .insert(devices)
    .values({ id: deviceId, userId, platform })
    .onConflictDoUpdate({
      target: devices.id,
      set: { userId, platform, updatedAt: new Date(), wipeRequestedAt: null },
    });
}

/**
 * The access token is a session row with a short expiry, not a JWT. Revocation
 * has to be immediate when an account is suspended, and a stateless token
 * cannot do that.
 */
export async function issueTokens(
  ctx: AuthContext,
  userId: string,
  deviceId: string | null,
  familyId: string = randomUUID(),
): Promise<IssuedTokens> {
  const accessToken = generateToken();
  const accessExpiresAt = new Date(Date.now() + ctx.config.ACCESS_TOKEN_MINUTES * 60_000);

  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: hashToken(accessToken),
    csrfTokenHash: hashToken(generateToken(8)),
    expiresAt: accessExpiresAt,
  });

  const refreshToken = generateToken();
  await ctx.db.insert(refreshTokens).values({
    userId,
    deviceId,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + ctx.config.REFRESH_TOKEN_DAYS * 86_400_000),
  });

  return { accessToken, accessTokenExpiresAt: accessExpiresAt, refreshToken };
}

export async function revokeFamily(db: Database, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/**
 * Rotates a refresh token.
 *
 * Presenting a token that has already been used means it was captured, so the
 * whole family is revoked rather than just that one token (doc 07 §3).
 */
export async function rotateRefreshToken(
  ctx: AuthContext,
  presented: string,
  actor: AuditActor,
): Promise<{ user: UserRow; tokens: IssuedTokens }> {
  const [existing] = await ctx.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(presented)))
    .limit(1);

  if (!existing) {
    throw new HttpError('unauthenticated', 'Please sign in again.');
  }

  // A token that has already been exchanged means someone captured it, so the
  // whole family goes (doc 07 §3).
  if (existing.usedAt !== null) {
    await revokeFamily(ctx.db, existing.familyId);
    await recordAudit(ctx.db, {
      action: 'auth.refresh_reuse_detected',
      actor: { ...actor, userId: existing.userId },
      entityType: 'user',
      entityId: existing.userId,
      metadata: { familyId: existing.familyId },
    });
    throw new HttpError('unauthenticated', 'Please sign in again.');
  }

  // Already revoked but never used is the ordinary aftermath: the legitimate
  // holder's unused token, killed when the family was revoked. Deny it, but do
  // not report it as a second theft.
  if (existing.revokedAt !== null) {
    await recordAudit(ctx.db, {
      action: 'auth.refresh_revoked',
      actor: { ...actor, userId: existing.userId },
      entityType: 'user',
      entityId: existing.userId,
      metadata: { familyId: existing.familyId },
    });
    throw new HttpError('unauthenticated', 'Please sign in again.');
  }

  if (existing.expiresAt <= new Date()) {
    throw new HttpError('unauthenticated', 'Please sign in again.');
  }

  const user = await findById(ctx.db, existing.userId);
  if (!user) throw new HttpError('unauthenticated', 'Please sign in again.');
  assertUsable(user.status);

  await ctx.db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(eq(refreshTokens.id, existing.id));

  const tokens = await issueTokens(ctx, user.id, existing.deviceId, existing.familyId);
  return { user, tokens };
}

/**
 * Kills everything for a user: web sessions, access tokens and every refresh
 * token family. Used by sign-out, by suspension, and by the CLI.
 */
export async function revokeAllForUser(db: Database, userId: string): Promise<void> {
  const now = new Date();
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

// ---------------------------------------------------------------------------
// TOTP enrolment
// ---------------------------------------------------------------------------

export type TotpEnrolment = {
  secret: string;
  provisioningUri: string;
  recoveryCodes: string[];
};

/**
 * Starts enrolment. The secret is stored immediately but `totp_enabled_at`
 * stays null until a code is confirmed, so a half-finished enrolment cannot
 * lock anyone out.
 */
export async function beginTotpEnrolment(ctx: AuthContext, user: UserRow): Promise<TotpEnrolment> {
  const secret = generateTotpSecret();

  await ctx.db
    .update(users)
    .set({
      totpSecretEnc: encryptField(ctx.keyRing, TOTP_SECRET_COLUMN, secret),
      totpEnabledAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  // Codes are shown once here and only their hashes are kept.
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  await ctx.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
  await ctx.db.insert(recoveryCodes).values(
    codes.map((code) => ({
      userId: user.id,
      codeHash: hashToken(normaliseRecoveryCode(code)),
    })),
  );

  return {
    secret,
    provisioningUri: totpProvisioningUri(secret, user.email),
    recoveryCodes: codes,
  };
}

export async function confirmTotpEnrolment(
  ctx: AuthContext,
  user: UserRow,
  code: string,
  actor: AuditActor,
): Promise<void> {
  if (user.totpSecretEnc === null) {
    throw new HttpError('validation_failed', 'Start enrolment before confirming a code.');
  }

  const secret = decryptField(ctx.keyRing, TOTP_SECRET_COLUMN, user.totpSecretEnc);
  if (!verifyTotp(secret, code)) {
    throw new HttpError('validation_failed', 'That code is not correct. Try the next one.');
  }

  await ctx.db
    .update(users)
    .set({ totpEnabledAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await recordAudit(ctx.db, {
    action: 'auth.totp_enrolled',
    actor,
    entityType: 'user',
    entityId: user.id,
  });
}

export type { Role };
