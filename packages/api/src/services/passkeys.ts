import { and, eq, isNull } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  PASSKEY_USER_VERIFICATION,
  type PasskeyAuthentication,
  type PasskeyRegistration,
  type PasskeySummary,
  type Platform,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { users, webauthnChallenges, webauthnCredentials } from '../db/schema.js';
import { HttpError } from '../middleware/errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { AuthContext, UserRow } from './auth.js';

/**
 * Passkeys (#24, doc 01 §10).
 *
 * A passkey replaces the password and the second factor in one ceremony,
 * because the authenticator only answers after it has verified the person
 * holding it. That is the whole reason `userVerification` is required at both
 * ends and why the verified flag is checked on the way back in rather than
 * assumed from having asked: an authenticator that answers without verifying
 * would turn a stolen unlocked laptop into whatever role that account has.
 *
 * Sign-in is discoverable, so the browser is not given a list of credentials
 * to try. Handing an unauthenticated caller the credential ids for an email
 * address tells them which addresses have accounts, and a resident key does
 * not need the hint: it says who it belongs to afterwards.
 */

const CHALLENGE_TTL_MS = 5 * 60_000;

const REGISTER = 'register';
const AUTHENTICATE = 'authenticate';

/**
 * Where the credential is scoped. A passkey is bound to a domain, so this has
 * to be the site's own host and nothing above it.
 *
 * Taken from the first configured origin rather than from the request, because
 * a `Host` header an attacker controls is a passkey scoped wherever they like.
 */
export function relyingParty(ctx: AuthContext): { id: string; origins: string[]; name: string } {
  const origins = ctx.config.CORS_ORIGINS;
  const first = origins[0] ?? 'http://localhost:8081';
  return { id: new URL(first).hostname, origins: [...origins], name: 'Vigilo' };
}

async function storeChallenge(
  ctx: AuthContext,
  challenge: string,
  purpose: string,
  meta: { userId?: string | null; deviceId?: string | null; platform?: Platform | null } = {},
): Promise<void> {
  await ctx.db.insert(webauthnChallenges).values({
    challenge,
    purpose,
    userId: meta.userId ?? null,
    deviceId: meta.deviceId ?? null,
    platform: meta.platform ?? null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

type ChallengeRow = typeof webauthnChallenges.$inferSelect;

/**
 * Takes the challenge back out, once.
 *
 * Marked consumed in the same statement that finds it, so two requests racing
 * the same challenge cannot both win. A replayed ceremony is exactly what a
 * stored challenge exists to refuse.
 */
async function consumeChallenge(
  ctx: AuthContext,
  challenge: string,
  purpose: string,
): Promise<ChallengeRow> {
  const [row] = await ctx.db
    .update(webauthnChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.purpose, purpose),
        isNull(webauthnChallenges.consumedAt),
      ),
    )
    .returning();

  if (!row || row.expiresAt <= new Date()) {
    throw new HttpError('unauthenticated', 'That took too long. Start again.');
  }
  return row;
}

function toSummary(row: typeof webauthnCredentials.$inferSelect): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    syncedAcrossDevices: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------- registration */

export async function beginPasskeyRegistration(
  ctx: AuthContext,
  user: UserRow,
): Promise<Record<string, unknown>> {
  const rp = relyingParty(ctx);

  const existing = await ctx.db
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, user.id), isNull(webauthnCredentials.revokedAt)));

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    // The account, not the person: the display name shows in the authenticator's
    // own list, and an email is what tells two accounts apart there.
    userName: user.email,
    userDisplayName: user.displayName,
    attestationType: 'none',
    // Registering the same authenticator twice would leave a credential that
    // can never be used, because the newer one wins the lookup.
    excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: PASSKEY_USER_VERIFICATION,
    },
    timeout: CHALLENGE_TTL_MS,
  });

  await storeChallenge(ctx, options.challenge, REGISTER, { userId: user.id });
  return options as unknown as Record<string, unknown>;
}

export async function finishPasskeyRegistration(
  ctx: AuthContext,
  user: UserRow,
  credential: PasskeyRegistration,
  name: string,
  actor: AuditActor,
): Promise<PasskeySummary> {
  const rp = relyingParty(ctx);
  const challenge = readChallenge(credential.response.clientDataJSON);
  const row = await consumeChallenge(ctx, challenge, REGISTER);

  if (row.userId !== user.id) {
    throw new HttpError('unauthenticated', 'That took too long. Start again.');
  }

  const verification = await verifyRegistrationResponse({
    response: credential as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    requireUserVerification: true,
  }).catch(() => null);

  if (!verification?.verified || !verification.registrationInfo) {
    throw new HttpError('validation_failed', 'That passkey could not be set up. Try again.');
  }

  const info = verification.registrationInfo;

  const [saved] = await ctx.db
    .insert(webauthnCredentials)
    .values({
      userId: user.id,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      signCount: info.credential.counter,
      transports: (info.credential.transports ?? []).join(',') || null,
      backedUp: info.credentialBackedUp,
      name,
    })
    .returning();

  if (!saved) throw new HttpError('server_error', 'That passkey could not be saved. Try again.');

  await recordAudit(ctx.db, {
    action: 'auth.passkey_registered',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    metadata: { passkeyId: saved.id, syncedAcrossDevices: saved.backedUp },
  });

  return toSummary(saved);
}

/* ----------------------------------------------------------- authentication */

export async function beginPasskeyAuthentication(
  ctx: AuthContext,
  meta: { deviceId?: string | undefined; platform?: Platform | undefined },
): Promise<Record<string, unknown>> {
  const rp = relyingParty(ctx);

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: PASSKEY_USER_VERIFICATION,
    timeout: CHALLENGE_TTL_MS,
  });

  await storeChallenge(ctx, options.challenge, AUTHENTICATE, {
    deviceId: meta.deviceId ?? null,
    platform: meta.platform ?? null,
  });

  return options as unknown as Record<string, unknown>;
}

/**
 * The same answer for every failure, deliberately.
 *
 * An unknown credential and a bad signature have to be indistinguishable, or
 * the route tells somebody holding a stolen key whether it is one Vigilo
 * knows.
 */
const REFUSED = 'That passkey did not work. Sign in with your password instead.';

export async function completePasskeyAuthentication(
  ctx: AuthContext,
  credential: PasskeyAuthentication,
  actor: AuditActor,
): Promise<{ user: UserRow; challenge: ChallengeRow }> {
  const rp = relyingParty(ctx);
  const challenge = readChallenge(credential.response.clientDataJSON);
  const row = await consumeChallenge(ctx, challenge, AUTHENTICATE);

  const [stored] = await ctx.db
    .select()
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.credentialId, credential.id),
        isNull(webauthnCredentials.revokedAt),
      ),
    )
    .limit(1);

  if (!stored) {
    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor,
      metadata: { reason: 'unknown_passkey' },
    });
    throw new HttpError('unauthenticated', REFUSED);
  }

  const transports = splitTransports(stored.transports);

  const verification = await verifyAuthenticationResponse({
    response: credential as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge: challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: stored.signCount,
      ...(transports === undefined ? {} : { transports }),
    },
  }).catch(() => null);

  if (!verification?.verified) {
    await recordAudit(ctx.db, {
      action: 'auth.login_failed',
      actor,
      entityType: 'user',
      entityId: stored.userId,
      metadata: { reason: 'passkey_rejected' },
    });
    throw new HttpError('unauthenticated', REFUSED);
  }

  const [user] = await ctx.db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
  if (!user || user.status !== 'active') throw new HttpError('unauthenticated', REFUSED);

  await ctx.db
    .update(webauthnCredentials)
    .set({
      signCount: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    })
    .where(eq(webauthnCredentials.id, stored.id));

  await ctx.db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await recordAudit(ctx.db, {
    action: 'auth.login',
    actor: { ...actor, userId: user.id },
    entityType: 'user',
    entityId: user.id,
    // A passkey is both factors at once, which is worth being able to prove.
    metadata: { secondFactor: 'passkey', passkeyId: stored.id },
  });

  return { user, challenge: row };
}

/* -------------------------------------------------------------- management */

export async function listPasskeys(db: Database, userId: string): Promise<PasskeySummary[]> {
  const rows = await db
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)));

  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => toSummary(row));
}

export async function renamePasskey(
  db: Database,
  userId: string,
  id: string,
  name: string,
): Promise<PasskeySummary> {
  const [row] = await db
    .update(webauthnCredentials)
    .set({ name })
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, userId),
        isNull(webauthnCredentials.revokedAt),
      ),
    )
    .returning();

  if (!row) throw new HttpError('not_found', 'That passkey is not on your account.');
  return toSummary(row);
}

/**
 * Revoked, not deleted. Which credentials an account had and when they stopped
 * working is exactly the sort of thing somebody has to be able to answer later.
 */
export async function revokePasskey(
  db: Database,
  userId: string,
  id: string,
  actor: AuditActor,
): Promise<void> {
  const [row] = await db
    .update(webauthnCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.userId, userId),
        isNull(webauthnCredentials.revokedAt),
      ),
    )
    .returning();

  if (!row) throw new HttpError('not_found', 'That passkey is not on your account.');

  await recordAudit(db, {
    action: 'auth.passkey_removed',
    actor,
    entityType: 'user',
    entityId: userId,
    metadata: { passkeyId: id },
  });
}

/* -------------------------------------------------------------------- bits */

function splitTransports(value: string | null): PasskeyAuthenticatorTransport[] | undefined {
  if (value === null || value === '') return undefined;
  return value.split(',') as PasskeyAuthenticatorTransport[];
}

type PasskeyAuthenticatorTransport = NonNullable<
  NonNullable<Parameters<typeof verifyAuthenticationResponse>[0]['credential']>['transports']
>[number];

/**
 * The challenge the browser says it answered.
 *
 * Read from client data so the row can be found, then handed to the verifier
 * as the expected value. That is not circular: the verifier checks the
 * signature covers this exact client data, and the row proves Vigilo issued
 * the challenge and that nothing has used it before.
 */
function readChallenge(clientDataJSON: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    const challenge = (parsed as { challenge?: unknown }).challenge;
    if (typeof challenge !== 'string' || challenge === '') {
      throw new Error('no challenge');
    }
    return challenge;
  } catch {
    throw new HttpError('validation_failed', 'That passkey response could not be read.');
  }
}
