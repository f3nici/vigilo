import { Router } from 'express';
import { z } from 'zod';
import { inArray, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { participants } from '../db/schema.js';
import { assertInScope } from '../services/scope.js';
import { recordParticipantView } from '../services/audit.js';
import { currentPrincipal, requireAuth } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Phase 1 exposes only what the access model needs to be provable: a scoped
 * list and a scoped read. Names and every other encrypted field arrive in
 * Phase 2, along with create, update and archive.
 *
 * The point of these two routes now is that the scope layer is real and
 * exercised, rather than something Phase 2 has to retrofit.
 */
export function participantRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);

      const rows =
        principal.scope.kind === 'all'
          ? await db.select({ id: participants.id, status: participants.status }).from(participants)
          : principal.scope.participantIds.length === 0
            ? []
            : await db
                .select({ id: participants.id, status: participants.status })
                .from(participants)
                .where(inArray(participants.id, principal.scope.participantIds));

      res.json({ participants: rows });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      // Scope first. An out-of-scope request is denied whether or not the
      // participant exists, so the response never leaks existence.
      assertInScope(principal.scope, id);

      const [row] = await db
        .select({ id: participants.id, status: participants.status })
        .from(participants)
        .where(eq(participants.id, id))
        .limit(1);

      if (!row) throw new HttpError('not_found', 'That participant does not exist.');

      // Opening a participant is logged, batched per 15 minutes (doc 07 §4).
      await recordParticipantView(db, req.auditActor, id);

      res.json({ participant: row });
    }),
  );

  return router;
}
