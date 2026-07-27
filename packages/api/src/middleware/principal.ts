import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import type { Role, Scope } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { hashToken } from '../crypto/passwords.js';
import { findById, pendingRequirement, touchSession, type UserRow } from '../services/auth.js';
import { resolveScopeFor } from '../services/scope.js';
import { getOrgSettings } from '../services/org.js';
import { HttpError } from './errors.js';
import type { AuditActor } from '../services/audit.js';

export const SESSION_COOKIE = 'vigilo_session';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_COOKIE = 'vigilo_csrf';

/**
 * Every request resolves to a principal in middleware, and every data access
 * goes through the scope layer (doc 02 §5). Nothing downstream reads a cookie
 * or a header to work out who is calling.
 */
declare module 'express-serve-static-core' {
  interface Request {
    principal?: PrincipalContext;
    auditActor: AuditActor;
  }
}

export type AuthModel = 'session-cookie' | 'refresh-token';

export type PrincipalContext = {
  user: UserRow;
  role: Role;
  scope: Scope;
  sessionId: string;
  authModel: AuthModel;
};

/** Populated on every request, authenticated or not, for audit purposes. */
export function auditActorMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.auditActor = {
      userId: null,
      ip: req.ip ?? null,
      deviceId: null,
    };
    next();
  };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}

/**
 * Resolves the principal if a credential is present, and leaves it unset
 * otherwise. Routes declare their own requirement with `requireAuth`.
 */
export function loadPrincipal(db: Database): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const cookieToken = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
        const bearer = bearerToken(req);
        const token = bearer ?? cookieToken ?? null;

        if (!token) {
          next();
          return;
        }

        const [session] = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
          .limit(1);

        if (!session || session.expiresAt <= new Date()) {
          next();
          return;
        }

        const user = await findById(db, session.userId);
        if (!user || user.status !== 'active') {
          next();
          return;
        }

        const authModel: AuthModel = bearer ? 'refresh-token' : 'session-cookie';

        // A browser tab has a sliding idle window. An installed app's access
        // token is short-lived by design and rotates instead.
        if (authModel === 'session-cookie') {
          const org = await getOrgSettings(db);
          await touchSession(db, session.id, org.sessionIdleMinutesWeb);
        }

        const scope = await resolveScopeFor(db, {
          userId: user.id,
          role: user.role,
          participantId: user.participantId,
        });

        req.principal = { user, role: user.role, scope, sessionId: session.id, authModel };
        req.auditActor = { userId: user.id, ip: req.ip ?? null, deviceId: null };

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function currentPrincipal(req: Request): PrincipalContext {
  if (!req.principal) {
    throw new HttpError('unauthenticated', 'Please sign in.');
  }
  return req.principal;
}

/**
 * Requires a signed-in principal, and by default refuses to let an account
 * with an outstanding requirement do anything else. `allowPending` is for the
 * two routes that resolve those requirements.
 */
export function requireAuth(options: { allowPending?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const principal = currentPrincipal(req);

    if (!options.allowPending) {
      const requirement = pendingRequirement(principal.user);
      if (requirement === 'password_change_required') {
        next(new HttpError('password_change_required', 'Change your password before continuing.'));
        return;
      }
      if (requirement === 'totp_required') {
        next(new HttpError('totp_required', 'Set up two-factor authentication to continue.'));
        return;
      }
    }

    next();
  };
}

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    const principal = currentPrincipal(req);
    if (!allowed.includes(principal.role)) {
      next(new HttpError('scope_denied', 'You do not have access to this.'));
      return;
    }
    next();
  };
}

/**
 * Double-submit CSRF for the browser session model (doc 02 §5).
 *
 * A bearer token cannot be sent by a cross-site form, so the installed app is
 * exempt. A cookie can, so anything cookie-authenticated must present the
 * matching header.
 */
export function csrfProtection(): RequestHandler {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);

  return (req: Request, _res: Response, next: NextFunction) => {
    if (safe.has(req.method)) {
      next();
      return;
    }
    if (!req.principal || req.principal.authModel !== 'session-cookie') {
      next();
      return;
    }

    const header = req.headers[CSRF_HEADER];
    const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];

    if (typeof header !== 'string' || !header || header !== cookie) {
      next(new HttpError('validation_failed', 'Your session expired. Reload and try again.'));
      return;
    }

    next();
  };
}
