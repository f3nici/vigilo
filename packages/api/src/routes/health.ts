import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { isReady, type HealthResponse, type ReadyResponse } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { migrationsPending } from '../db/migrate.js';

/**
 * Liveness and readiness (doc 02 §7, doc 04 §15). Neither requires auth, so
 * neither says anything about the deployment beyond the build hash.
 */
export function healthRoutes(db: Database, buildHash: string): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', build: buildHash };
    res.json(body);
  });

  router.get('/ready', async (_req, res) => {
    const checks = { database: false, migrations: false };

    try {
      await db.execute(sql`select 1`);
      checks.database = true;
    } catch {
      // Reported as not ready. The reason stays in the logs, not the response.
    }

    if (checks.database) {
      try {
        checks.migrations = !(await migrationsPending(db));
      } catch {
        checks.migrations = false;
      }
    }

    const ready = isReady(checks);
    const body: ReadyResponse = {
      status: ready ? 'ready' : 'not_ready',
      build: buildHash,
      checks,
    };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
