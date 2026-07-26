import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Database } from './db/client.js';
import { healthRoutes } from './routes/health.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

export function createApp(config: Config, logger: Logger, db: Database): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));

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

  app.use('/api', healthRoutes(db, config.BUILD_HASH));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
