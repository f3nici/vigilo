import { Router, type CookieOptions, type Request, type Response } from 'express';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  recoveryCodeRequestSchema,
  refreshRequestSchema,
  totpChallengeRequestSchema,
  type LoginResponse,
  type MeResponse,
  type TotpEnrolResponse,
} from '@vigilo/shared';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Config } from '../config.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  beginTotpEnrolment,
  changePassword,
  completeRecoveryChallenge,
  completeTotpChallenge,
  createSession,
  confirmTotpEnrolment,
  issueTokens,
  login,
  registerDevice,
  revokeAllForUser,
  revokeSession,
  rotateRefreshToken,
  toPrincipal,
  type AuthContext,
  type UserRow,
} from '../services/auth.js';
import { getOrgSettings } from '../services/org.js';
import { resolveScopeFor } from '../services/scope.js';
import { recordAudit } from '../services/audit.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  currentPrincipal,
  requireAuth,
} from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

function cookieOptions(config: Config, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE,
    sameSite: config.SESSION_SAMESITE,
    path: '/',
    maxAge: maxAgeMs,
  };
}

/**
 * A browser tab gets the httpOnly session cookie plus a readable CSRF cookie.
 * An installed app gets tokens in the body and stores them in the platform
 * secure store instead (doc 02 §5).
 */
async function completeBrowserLogin(
  ctx: AuthContext,
  res: Response,
  req: Request,
  user: UserRow,
): Promise<LoginResponse> {
  const org = await getOrgSettings(ctx.db);
  const issued = await createSession(ctx, user.id, org.sessionIdleMinutesWeb, {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });

  const maxAge = org.sessionIdleMinutesWeb * 60_000;
  res.cookie(SESSION_COOKIE, issued.sessionToken, cookieOptions(ctx.config, maxAge));
  res.cookie(CSRF_COOKIE, issued.csrfToken, {
    ...cookieOptions(ctx.config, maxAge),
    // Readable by the SPA so it can echo it back in the header.
    httpOnly: false,
  });

  return { result: 'authenticated', principal: toPrincipal(user) };
}

async function completeAppLogin(
  ctx: AuthContext,
  user: UserRow,
  deviceId: string,
): Promise<LoginResponse> {
  const tokens = await issueTokens(ctx, user.id, deviceId);
  return {
    result: 'authenticated',
    principal: toPrincipal(user),
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
  };
}

export function authRoutes(db: Database, config: Config, keyRing: KeyRing): Router {
  const router = Router();
  const ctx: AuthContext = { db, config, keyRing };

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const request = loginRequestSchema.parse(req.body);
      const outcome = await login(ctx, request, req.auditActor);

      if (outcome.result === 'totp_required') {
        const body: LoginResponse = {
          result: 'totp_required',
          challengeId: outcome.challengeId,
        };
        res.json(body);
        return;
      }

      if (request.deviceId && request.platform) {
        await registerDevice(ctx, outcome.user.id, request.deviceId, request.platform);
        res.json(await completeAppLogin(ctx, outcome.user, request.deviceId));
        return;
      }

      res.json(await completeBrowserLogin(ctx, res, req, outcome.user));
    }),
  );

  router.post(
    '/totp',
    asyncHandler(async (req, res) => {
      const { challengeId, code } = totpChallengeRequestSchema.parse(req.body);
      const { user, challenge } = await completeTotpChallenge(
        ctx,
        challengeId,
        code,
        req.auditActor,
      );

      if (challenge.deviceId && challenge.platform) {
        await registerDevice(ctx, user.id, challenge.deviceId, challenge.platform);
        res.json(await completeAppLogin(ctx, user, challenge.deviceId));
        return;
      }

      res.json(await completeBrowserLogin(ctx, res, req, user));
    }),
  );

  router.post(
    '/recovery-code',
    asyncHandler(async (req, res) => {
      const { challengeId, code } = recoveryCodeRequestSchema.parse(req.body);
      const { user, challenge } = await completeRecoveryChallenge(
        ctx,
        challengeId,
        code,
        req.auditActor,
      );

      if (challenge.deviceId && challenge.platform) {
        await registerDevice(ctx, user.id, challenge.deviceId, challenge.platform);
        res.json(await completeAppLogin(ctx, user, challenge.deviceId));
        return;
      }

      res.json(await completeBrowserLogin(ctx, res, req, user));
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const { refreshToken } = refreshRequestSchema.parse(req.body);
      const { user, tokens } = await rotateRefreshToken(ctx, refreshToken, req.auditActor);

      res.json({
        result: 'authenticated',
        principal: toPrincipal(user),
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
      } satisfies LoginResponse);
    }),
  );

  /** Resolves the forced change, so it runs before the requirement check. */
  router.post(
    '/password',
    requireAuth({ allowPending: true }),
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { currentPassword, newPassword } = changePasswordRequestSchema.parse(req.body);

      await changePassword(ctx, principal.user, currentPassword, newPassword, req.auditActor);

      // Every other session for this user is now stale.
      await revokeAllForUser(db, principal.user.id);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.clearCookie(CSRF_COOKIE, { path: '/' });

      res.status(204).end();
    }),
  );

  router.post(
    '/totp/enrol',
    requireAuth({ allowPending: true }),
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      if (principal.user.totpEnabledAt !== null) {
        throw new HttpError(
          'conflict',
          'Two-factor authentication is already set up. An admin can reset it.',
        );
      }

      const enrolment = await beginTotpEnrolment(ctx, principal.user);
      const body: TotpEnrolResponse = {
        provisioningUri: enrolment.provisioningUri,
        secret: enrolment.secret,
        recoveryCodes: enrolment.recoveryCodes,
      };
      res.json(body);
    }),
  );

  router.post(
    '/totp/confirm',
    requireAuth({ allowPending: true }),
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { code } = z.object({ code: z.string() }).parse(req.body);

      await confirmTotpEnrolment(ctx, principal.user, code, req.auditActor);
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    requireAuth({ allowPending: true }),
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const org = await getOrgSettings(db);
      const scope = await resolveScopeFor(db, {
        userId: principal.user.id,
        role: principal.role,
        participantId: principal.user.participantId,
      });

      const body: MeResponse = {
        principal: toPrincipal(principal.user),
        scope: {
          all: scope.kind === 'all',
          participantIds: scope.kind === 'all' ? [] : scope.participantIds,
        },
        org: { name: org.orgName, timezone: org.timezone },
      };
      res.json(body);
    }),
  );

  router.post(
    '/logout',
    requireAuth({ allowPending: true }),
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);

      await revokeSession(db, principal.sessionId);
      await recordAudit(db, {
        action: 'auth.logout',
        actor: req.auditActor,
        entityType: 'user',
        entityId: principal.user.id,
      });

      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.clearCookie(CSRF_COOKIE, { path: '/' });
      res.status(204).end();
    }),
  );

  return router;
}
