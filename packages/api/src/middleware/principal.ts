import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import type { ParticipantAccess, Role, Scope } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { hashToken } from '../crypto/passwords.js';
import { findById, pendingRequirement, touchSession, type UserRow } from '../services/auth.js';
import { resolveScopeDetail } from '../services/scope.js';
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
  /** How this principal reaches each participant in scope. Empty for admins. */
  access: Map<string, ParticipantAccess>;
  sessionId: string;
  authModel: AuthModel;
};

/** An admin is not limited to a list, so nothing about their access expires. */
export function accessTo(principal: PrincipalContext, participantId: string): ParticipantAccess {
  return principal.access.get(participantId) ?? { kind: 'all', expiresAt: null };
}

export const DEVICE_HEADER = 'x-device-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The device the request came from, if it named one.
 *
 * This is a claim, not a credential. It is recorded on audit rows and used to
 * move that device's own sync cursor, and every query that touches a device
 * row also matches on the user, so naming somebody else's device achieves
 * nothing beyond writing a wrong id into your own audit trail.
 */
function claimedDeviceId(req: Request): string | null {
  const header = req.headers[DEVICE_HEADER];
  if (typeof header !== 'string' || !UUID.test(header)) return null;
  return header.toLowerCase();
}

/** Populated on every request, authenticated or not, for audit purposes. */
export function auditActorMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.auditActor = {
      userId: null,
      ip: req.ip ?? null,
      deviceId: claimedDeviceId(req),
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

        const { scope, access } = await resolveScopeDetail(db, {
          userId: user.id,
          role: user.role,
          participantId: user.participantId,
        });

        req.principal = { user, role: user.role, scope, access, sessionId: session.id, authModel };
        req.auditActor = {
          userId: user.id,
          ip: req.ip ?? null,
          deviceId: claimedDeviceId(req),
        };

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

/**
 * Guards on a capability from @vigilo/shared rather than a hand-written role
 * list, so the API and the UI cannot disagree about who may do what.
 *
 * This is the role half of the check only. Whether the participant is in scope
 * is a separate question, answered by the scope layer, and both always apply.
 */
export function requireCapability(can: (role: Role) => boolean, message: string): RequestHandler {
  return (req, _res, next) => {
    const principal = currentPrincipal(req);
    if (!can(principal.role)) {
      next(new HttpError('scope_denied', message));
      return;
    }
    next();
  };
}

/**
 * The whole API surface a self-access account may reach (doc 06 §6).
 *
 * An allow-list, deliberately, and deliberately in one place rather than a
 * guard added to each staff route. A participant is in scope for their own
 * record, so `assertInScope` passes for them on every route that takes their
 * id, and every one of those routes serves a staff DTO: the participant record
 * with its NDIS number and its alerts, windows including the ones nobody
 * recorded, the care plan, the medication chart. None of that is what doc 06
 * §6 describes.
 *
 * Guarding each of them would work until phase 10 adds the eleventh, and the
 * cost of forgetting is a participant reading something written about them
 * that was never meant for them. This way a new route is refused by default
 * and has to be named here to be reachable.
 */
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const SELF_ACCESS_ALLOWED: { methods: readonly string[] | 'any'; pattern: RegExp }[] = [
  // Signing in, signing out, changing a password, enrolling in TOTP.
  { methods: 'any', pattern: /^\/auth(\/|$)/ },
  { methods: ['GET'], pattern: /^\/me\/day$/ },
  { methods: ['GET'], pattern: /^\/me\/records$/ },
  { methods: ['GET'], pattern: /^\/me\/reports\/daily\.pdf$/ },
  /*
   * A photo on one of their own visible entries. The attachment routes were
   * already built for this: they apply the owning entry's read rule on top of
   * scope, so a photo on an entry marked not visible answers not_found. Read
   * methods only, so the DELETE that shares this path never reaches the
   * capability check that would refuse it.
   */
  { methods: ['GET'], pattern: new RegExp(`^/attachments/${UUID_PATH}(/(thumb|meta))?$`, 'i') },
];

export function selfAccessMayReach(method: string, path: string): boolean {
  // Express routes `/me/day/` and `/me/day` to the same handler, so they have
  // to be the same answer here too.
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const verb = method.toUpperCase();

  return SELF_ACCESS_ALLOWED.some(
    (allowed) =>
      allowed.pattern.test(normalised) &&
      (allowed.methods === 'any' || allowed.methods.includes(verb)),
  );
}

/**
 * Applied once, above every router, so nothing has to remember it.
 *
 * Mounted at `/api/v1`, which is why the patterns above are written without
 * that prefix: `req.path` inside a mounted handler is the part after it.
 */
export function restrictSelfAccess(): RequestHandler {
  return (req, _res, next) => {
    // Not signed in, or signed in as staff. `requireAuth` on each router
    // decides the first case; this middleware is only about the second.
    if (!req.principal || req.principal.role !== 'participant') {
      next();
      return;
    }

    if (selfAccessMayReach(req.method, req.path)) {
      next();
      return;
    }

    next(new HttpError('scope_denied', 'Your account can only see your own record.'));
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
