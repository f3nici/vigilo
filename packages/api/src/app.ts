import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
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
import { syncRoutes, deviceRoutes } from './routes/sync.js';
import { notificationPreferenceRoutes, pushRoutes } from './routes/push.js';
import { createFileStore } from './services/storage.js';
import { vapidKeys } from './services/vapid.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { auditActorMiddleware, csrfProtection, loadPrincipal } from './middleware/principal.js';

export function createApp(config: Config, logger: Logger, db: Database, keyRing: KeyRing): Express {
  const app = express();
  const store = createFileStore(config.ATTACHMENT_DIR);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' && existing ? existing : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

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
  app.use('/api/v1', loadPrincipal(db), csrfProtection());
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

  // Sync and push. Everything they touch already exists; these are the two
  // surfaces that put it on a phone with no signal (doc 04 §13 and §14).
  app.use('/api/v1/sync', syncRoutes(db, keyRing));
  app.use('/api/v1/devices', deviceRoutes(db));
  app.use('/api/v1/push', pushRoutes(db, vapidKeys(config)));
  app.use('/api/v1/me', notificationPreferenceRoutes(db));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
