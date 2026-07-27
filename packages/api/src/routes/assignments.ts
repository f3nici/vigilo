import { Router } from 'express';
import { z } from 'zod';
import { canGrantAccess } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { findAssignment, revokeAssignment } from '../services/assignments.js';
import { assertInScope } from '../services/scope.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Revoking access (doc 04 §4). Separate from the participant routes because an
 * assignment id is enough to find it, and the caller revoking a grant may not
 * know which participant it belongs to.
 */
export function assignmentRoutes(db: Database): Router {
  const router = Router();

  router.use(
    requireAuth(),
    requireCapability(canGrantAccess, 'Only an admin or a team leader can change who has access.'),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      // A team leader can only revoke access to someone in their own scope.
      const existing = await findAssignment(db, id);
      assertInScope(principal.scope, existing.participantId);

      res.json({ assignment: await revokeAssignment(db, id, req.auditActor) });
    }),
  );

  return router;
}
