import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp, type Options } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Database } from './db/client.js';
import type { KeyRing } from './crypto/keys.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { participantRoutes } from './routes/participants.js';
import { assignmentRoutes } from './routes/assignments.js';
import { templateRoutes, templateVersionRoutes } from './routes/templates.js';
import {
  checkEntryRoutes,
  coverageExceptionRoutes,
  myWindowRoutes,
  participantCheckRoutes,
  reasonCodeRoutes,
  scheduleRoutes,
  windowRoutes,
} from './routes/checks.js';
import {
  attachmentRoutes,
  diaryCategoryRoutes,
  diaryEntryRoutes,
  participantDiaryRoutes,
} from './routes/diary.js';
import {
  administrationRoutes,
  colleagueRoutes,
  doseRoutes,
  medicationRoutes,
  myDoseRoutes,
  participantMedicationRoutes,
} from './routes/medications.js';
import {
  carePlanRoutes,
  carePlanVersionRoutes,
  incidentActionRoutes,
  incidentRoutes,
  myIncidentRoutes,
  participantCarePlanRoutes,
  participantIncidentRoutes,
} from './routes/clinical.js';
import { syncRoutes, deviceRoutes } from './routes/sync.js';
import { selfAccessRoutes } from './routes/selfaccess.js';
import { exportRoutes, reportRoutes } from './routes/reports.js';
import { createFileStore } from './services/storage.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import {
  auditActorMiddleware,
  csrfProtection,
  loadPrincipal,
  restrictSelfAccess,
} from './middleware/principal.js';

/**
 * Health and readiness, which docker polls and nobody wants to read about.
 *
 * Reads `originalUrl` first. Express rewrites `req.url` to the path relative to
 * the mount while a router is handling the request, so by the time pino-http
 * asks what level to log at, a request to `/api/health` can be sitting there as
 * `/health`. The logged path looked right regardless, because that comes from a
 * binding taken before routing, which is what made this look like the matcher
 * was fine when it was quietly never matching.
 */
function isProbe(req: { originalUrl?: string | undefined; url?: string | undefined }): boolean {
  const raw = req.originalUrl ?? req.url;
  if (raw === undefined) return false;
  const path = raw.split('?')[0];
  return path === '/api/health' || path === '/api/ready';
}

/**
 * What a request log is allowed to say (doc 02 §7).
 *
 * The default serialisers put every request and response header on every line,
 * which was helmet's nine constants repeated a few times a second and about
 * nine tenths of the volume. Method, path, status, duration and the request id
 * are what anybody actually reads, and they are also the four things that stay
 * safe to log: a header set can pick up a token the redact list has not been
 * taught about yet, and a URL cannot.
 *
 * The level says what happened rather than everything being info:
 *
 * - **error** for a 5xx or a thrown error, which is ours
 * - **warn** for a 4xx, which is usually the caller's
 * - **debug** for a healthy probe, so `docker compose logs` is not one
 *   `/api/health` every ten seconds. A probe that fails is not a probe anybody
 *   should have to ask for, so it keeps the level its status earns.
 * - **info** for everything else
 */
export function httpLogging(logger: Logger): Options {
  return {
    logger,

    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const id = typeof existing === 'string' && existing ? existing : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },

    serializers: {
      req: (req: {
        id?: unknown;
        method?: string | undefined;
        originalUrl?: string | undefined;
        url?: string | undefined;
      }) => ({
        id: req.id,
        method: req.method,
        url: req.originalUrl ?? req.url,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },

    customLogLevel: (req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      if (isProbe(req)) return 'debug';
      return 'info';
    },

    customSuccessMessage: (req, res) => `${req.method ?? ''} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method ?? ''} ${res.statusCode}`,
  };
}

export function createApp(config: Config, logger: Logger, db: Database, keyRing: KeyRing): Express {
  const app = express();
  const store = createFileStore(config.ATTACHMENT_DIR);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(pinoHttp(httpLogging(logger)));

  /**
   * Capacitor apps sign in from https://localhost. Allowing that origin and
   * setting SESSION_SAMESITE=none is what stops native sign-in failing
   * silently later (doc 02 §4).
   */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  /** Every response carries it so devices can measure clock skew (doc 04 §1). */
  app.use((_req, res, next) => {
    res.setHeader('X-Server-Time', new Date().toISOString());
    next();
  });

  app.use(auditActorMiddleware());

  // Health is deliberately outside auth and outside the principal lookup.
  app.use('/api', healthRoutes(db, config.BUILD_HASH));

  // Everything below resolves a principal first, so no route ever works out
  // who is calling for itself.
  /*
   * Everything below resolves a principal first, and a self-access account is
   * cut down to its own three screens before any router sees it (doc 06 §6).
   * That guard sits here rather than in each router so a route added later is
   * refused by default.
   */
  app.use('/api/v1', loadPrincipal(db), csrfProtection(), restrictSelfAccess());
  app.use('/api/v1/auth', authRoutes(db, config, keyRing));
  app.use('/api/v1/users', userRoutes(db));
  app.use('/api/v1/participants', participantRoutes(db, keyRing));
  // Schedules, coverage and windows hang off a participant too, in their own
  // file so neither router is about two things at once.
  app.use('/api/v1/participants', participantCheckRoutes(db, keyRing));
  app.use('/api/v1/assignments', assignmentRoutes(db));
  app.use('/api/v1/check-templates', templateRoutes(db));
  app.use('/api/v1/check-template-versions', templateVersionRoutes(db));
  app.use('/api/v1/schedules', scheduleRoutes(db));
  app.use('/api/v1/coverage-exceptions', coverageExceptionRoutes(db));
  app.use('/api/v1/windows', windowRoutes(db, keyRing));
  app.use('/api/v1/check-entries', checkEntryRoutes(db, keyRing));
  app.use('/api/v1/missed-reason-codes', reasonCodeRoutes(db));
  // The diary and the timeline hang off a participant as well, again in their
  // own file rather than piling a third subject onto one router.
  app.use('/api/v1/participants', participantDiaryRoutes(db, keyRing));
  app.use('/api/v1/diary-entries', diaryEntryRoutes(db, keyRing));
  app.use('/api/v1/diary-categories', diaryCategoryRoutes(db));
  app.use('/api/v1/attachments', attachmentRoutes(db, keyRing, store));
  app.use('/api/v1/me', myWindowRoutes(db, keyRing));

  // Medications hang off a participant too, in their own file for the same
  // reason as the checks and the diary (doc 04 §10).
  app.use('/api/v1/participants', participantMedicationRoutes(db, keyRing));
  app.use('/api/v1/medications', medicationRoutes(db, keyRing));
  app.use('/api/v1/medication-doses', doseRoutes(db, keyRing));
  app.use('/api/v1/medication-administrations', administrationRoutes(db, keyRing));
  app.use('/api/v1/me', myDoseRoutes(db, keyRing));
  app.use('/api/v1/me', colleagueRoutes(db));

  // Care plans and incidents (doc 04 §10), in their own file for the same
  // reason as the checks, the diary and the medications.
  app.use('/api/v1/participants', participantCarePlanRoutes(db, keyRing));
  app.use('/api/v1/care-plans', carePlanRoutes(db, keyRing));
  app.use('/api/v1/care-plan-versions', carePlanVersionRoutes(db, keyRing));
  app.use('/api/v1/participants', participantIncidentRoutes(db, keyRing));
  app.use('/api/v1/incidents', incidentRoutes(db, keyRing));
  app.use('/api/v1/incident-actions', incidentActionRoutes(db, keyRing));
  app.use('/api/v1/me', myIncidentRoutes(db, keyRing));

  // Participant self-access (doc 06 §6). Three read-only screens, and no
  // participant id anywhere in them: the service reads it off the principal.
  app.use('/api/v1/me', selfAccessRoutes(db, keyRing));

  // Sync. Everything it touches already exists; this is the surface that puts
  // it on a phone with no signal (doc 04 §13).
  app.use('/api/v1/sync', syncRoutes(db, keyRing));
  app.use('/api/v1/devices', deviceRoutes(db));

  // Reports and exports (doc 04 §11). No participant id in these URLs, so
  // scope is resolved inside the services from the caller's own.
  app.use('/api/v1/reports', reportRoutes(db, keyRing));
  app.use('/api/v1/exports', exportRoutes(db, keyRing, store));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
