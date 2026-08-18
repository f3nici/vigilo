import { and, eq, isNull } from 'drizzle-orm';
import {
  QUICK_SIGN_IN_DAYS,
  type QuickSignInCredential,
  type QuickSignInMethod,
  type QuickSignInSummary,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { deviceCredentials, users } from '../db/schema.js';
import { generateToken, hashPassword, verifyPassword } from '../crypto/passwords.js';
import { HttpError } from '../middleware/errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { AuthContext, UserRow } from './auth.js';

/**
 * Quick sign-in: the phone's fingerprint or a six-digit PIN, on a device that
 * has already signed in properly (#24, doc 01 §10).
 *
 * It is deliberately not an authentication factor. The secret here is high
 * entropy and Vigilo generated it; what the fingerprint or the PIN protects is
 * getting at it on the device, which is the device's own job and is what the
 * secure store already does for the local database key. So the security
 * argument is: this is only ever as strong as physical possession of an
 * unlocked phone, which is the same thing the records on that phone are
 * already worth.
 *
 * What follows from that:
 *
 * - It is issued only to somebody already signed in, never as a way in from
 *   nothing.
 * - It expires if it is not used, so a phone in a drawer stops working.
 * - Redeeming it is rate limited by the same account lockout a password is,
 *   because a stolen device with a wrong PIN typed forty times is exactly the
 *   case that has to stop.
 * - An admin suspending an account kills it, because every route checks status.
 */

const MAX_PER_USER = 8;

function toSummary(row: typeof deviceCredentials.$inferSelect): QuickSignInSummary {
  return {
    id: row.id,
    label: row.label,
    method: row.method as QuickSignInMethod,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function enrolQuickSignIn(
  ctx: AuthContext,
  user: UserRow,
  input: { method: QuickSignInMethod; label: string; deviceId: string | null },
  actor: AuditActor,
): Promise<QuickSignInCredential> {
  const existing = await ctx.db
    .select()
    .from(deviceCredentials)
    .where(and(eq(deviceCredentials.userId, user.id), isNull(deviceCredentials.revokedAt)));

  if (existing.length >= MAX_PER_USER) {
    throw new HttpError(
      'conflict',
      'There are already quick sign-ins on eight devices. Remove one first.',
    );
  }

  /*
   * One per device, replaced rather than added to. Setting a PIN up again on
   * the same phone is somebody redoing it, not somebody wanting two, and a
   * credential nothing on the device can still unseal is a credential that
   * only ever sits there being redeemable.
   */
  if (input.deviceId !== null) {
    await ctx.db
      .update(deviceCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(deviceCredentials.userId, user.id),
          eq(deviceCredentials.deviceId, input.deviceId),
          isNull(deviceCredentials.revokedAt),
        ),
      );
  }

  const secret = generateToken(32);
  const expiresAt = new Date(Date.now() + QUICK_SIGN_IN_DAYS * 86_400_000);

  const [row] = await ctx.db
    .insert(deviceCredentials)
    .values({
      userId: user.id,
      deviceId: input.deviceId,
      secretHash: await hashPassword(secret),
      method: input.method,
      label: input.label,
      expiresAt,
    })
    .returning();

  if (!row) throw new HttpError('server_error', 'That could not be set up. Try again.');

  await recordAudit(ctx.db, {
    action: 'auth.quick_sign_in_enrolled',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    metadata: { credentialId: row.id, method: input.method },
  });

  return { credentialId: row.id, secret, expiresAt: expiresAt.toISOString() };
}

/** The same answer for a wrong secret, an expired one and one that never was. */
const REFUSED = 'That did not work on this device. Sign in with your password.';

export async function redeemQuickSignIn(
  ctx: AuthContext,
  input: { credentialId: string; secret: string },
  actor: AuditActor,
): Promise<UserRow> {
  const [row] = await ctx.db
    .select()
    .from(deviceCredentials)
    .where(and(eq(deviceCredentials.id, input.credentialId), isNull(deviceCredentials.revokedAt)))
    .limit(1);

  if (!row || row.expiresAt <= new Date()) {
    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor,
      metadata: { reason: 'quick_sign_in_unknown' },
    });
    throw new HttpError('unauthenticated', REFUSED);
  }

  const [user] = await ctx.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || user.status !== 'active') throw new HttpError('unauthenticated', REFUSED);

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new HttpError(
      'rate_limited',
      'This account is locked after too many attempts. Try again later or ask an admin.',
    );
  }

  if (!(await verifyPassword(row.secretHash, input.secret))) {
    /*
     * A wrong secret here is not somebody mistyping: the device holds it and
     * either unseals it or does not. So the credential is retired outright
     * rather than counted, and the account's own lockout still applies on top.
     */
    await ctx.db
      .update(deviceCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(deviceCredentials.id, row.id));

    const attempts = user.failedAttempts + 1;
    await ctx.db
      .update(users)
      .set({
        failedAttempts: attempts,
        lockedUntil:
          attempts >= ctx.config.MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + ctx.config.LOCKOUT_MINUTES * 60_000)
            : user.lockedUntil,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor: { ...actor, userId: user.id },
      entityType: 'user',
      entityId: user.id,
      metadata: { reason: 'quick_sign_in_rejected', credentialId: row.id },
    });

    throw new HttpError('unauthenticated', REFUSED);
  }

  await ctx.db
    .update(deviceCredentials)
    .set({
      lastUsedAt: new Date(),
      // Used, so it lives another sixty days. A device somebody works from
      // every day should never quietly stop working.
      expiresAt: new Date(Date.now() + QUICK_SIGN_IN_DAYS * 86_400_000),
    })
    .where(eq(deviceCredentials.id, row.id));

  await ctx.db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await recordAudit(ctx.db, {
    action: 'auth.login',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    metadata: { secondFactor: false, quickSignIn: row.method, credentialId: row.id },
  });

  return user;
}

export async function listQuickSignIns(
  db: Database,
  userId: string,
): Promise<QuickSignInSummary[]> {
  const rows = await db
    .select()
    .from(deviceCredentials)
    .where(and(eq(deviceCredentials.userId, userId), isNull(deviceCredentials.revokedAt)));

  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toSummary);
}

export async function revokeQuickSignIn(
  db: Database,
  userId: string,
  id: string,
  actor: AuditActor,
): Promise<void> {
  const [row] = await db
    .update(deviceCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceCredentials.id, id),
        eq(deviceCredentials.userId, userId),
        isNull(deviceCredentials.revokedAt),
      ),
    )
    .returning();

  if (!row) throw new HttpError('not_found', 'That device is not on your account.');

  await recordAudit(db, {
    action: 'auth.quick_sign_in_removed',
    actor,
    entityType: 'user',
    entityId: userId,
    metadata: { credentialId: id },
  });
}

/** Sign-out on a shared device, and account suspension, both land here. */
export async function revokeAllQuickSignIns(db: Database, userId: string): Promise<void> {
  await db
    .update(deviceCredentials)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceCredentials.userId, userId), isNull(deviceCredentials.revokedAt)));
}
