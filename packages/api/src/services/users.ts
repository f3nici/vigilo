import { desc, eq, sql } from 'drizzle-orm';
import {
  requiresParticipantId,
  totpRequired,
  type CreateUserRequest,
  type Role,
  type UserSummary,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { generateOneTimePassword, hashPassword } from '../crypto/passwords.js';
import { recordAudit, type AuditActor } from './audit.js';
import { revokeAllForUser, type UserRow } from './auth.js';
import { requestDeviceWipe } from './devices.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Account administration (doc 01 §10).
 *
 * Accounts are created by admins, who set an initial password and hand it over
 * directly. There is no email, so nothing is sent anywhere: the one-time
 * password is returned once for the admin to read out, and never stored in
 * plaintext.
 */

export function toSummary(user: UserRow): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    participantId: user.participantId,
    mustChangePassword: user.mustChangePassword,
    totpEnabled: user.totpEnabledAt !== null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function listUsers(db: Database): Promise<UserSummary[]> {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  return rows.map(toSummary);
}

export type IssuedAccount = { user: UserRow; oneTimePassword: string };

export async function createUser(
  db: Database,
  request: CreateUserRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<IssuedAccount> {
  if (requiresParticipantId(request.role) !== Boolean(request.participantId)) {
    throw new HttpError(
      'validation_failed',
      'A participant account needs a participant, and no other role may have one.',
    );
  }

  const oneTimePassword = generateOneTimePassword();

  let created: UserRow;
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: request.email,
        displayName: request.displayName,
        role: request.role,
        participantId: request.participantId ?? null,
        passwordHash: await hashPassword(oneTimePassword),
        mustChangePassword: true,
        createdBy,
      })
      .returning();
    created = row!;
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw new HttpError('conflict', 'An account with that email already exists.');
    }
    throw error;
  }

  await recordAudit(db, {
    action: 'user.create',
    actor,
    entityType: 'user',
    entityId: created.id,
    // Role and id only. Never the password, never the email.
    metadata: { role: created.role, totpRequired: totpRequired(created.role) },
  });

  return { user: created, oneTimePassword };
}

/** Issues a fresh one-time password and forces a change at next sign-in. */
export async function resetPassword(
  db: Database,
  userId: string,
  actor: AuditActor,
): Promise<IssuedAccount> {
  const oneTimePassword = generateOneTimePassword();

  const [updated] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(oneTimePassword),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That account does not exist.');

  // Anything already signed in with the old password is now stale.
  await revokeAllForUser(db, userId);

  await recordAudit(db, {
    action: 'user.password_reset',
    actor,
    entityType: 'user',
    entityId: userId,
  });

  return { user: updated, oneTimePassword };
}

/**
 * Suspension is instant: it kills every session and refresh token family and
 * flags the user's devices for a local wipe at next contact (doc 07 §7).
 */
export async function suspendUser(
  db: Database,
  userId: string,
  actor: AuditActor,
): Promise<UserSummary> {
  const [updated] = await db
    .update(users)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That account does not exist.');

  await revokeAllForUser(db, userId);
  await requestDeviceWipe(db, userId);

  await recordAudit(db, {
    action: 'user.suspend',
    actor,
    entityType: 'user',
    entityId: userId,
  });

  return toSummary(updated);
}

export async function reinstateUser(
  db: Database,
  userId: string,
  actor: AuditActor,
): Promise<UserSummary> {
  const [updated] = await db
    .update(users)
    .set({
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That account does not exist.');

  await recordAudit(db, {
    action: 'user.reinstate',
    actor,
    entityType: 'user',
    entityId: userId,
  });

  return toSummary(updated);
}

/** Clears TOTP so the user can enrol again on a new device. */
export async function resetTotp(
  db: Database,
  userId: string,
  actor: AuditActor,
): Promise<UserSummary> {
  const [updated] = await db
    .update(users)
    .set({
      totpSecretEnc: null,
      totpEnabledAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That account does not exist.');

  await recordAudit(db, {
    action: 'user.totp_reset',
    actor,
    entityType: 'user',
    entityId: userId,
  });

  return toSummary(updated);
}

export async function unlockUser(
  db: Database,
  userId: string,
  actor: AuditActor,
): Promise<UserSummary> {
  const [updated] = await db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That account does not exist.');

  await recordAudit(db, {
    action: 'user.unlock',
    actor,
    entityType: 'user',
    entityId: userId,
  });

  return toSummary(updated);
}

/** So "is there another admin" is answerable before anyone is locked out. */
export async function countActiveAdmins(db: Database): Promise<number> {
  const [row] = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from users where role = 'admin' and status = 'active'`,
  );
  return Number(row?.count ?? 0);
}

export type { Role };
