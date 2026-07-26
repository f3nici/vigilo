import { Router } from 'express';
import { z } from 'zod';
import { createUserRequestSchema, type IssuedCredential, type UserSummary } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  createUser,
  listUsers,
  reinstateUser,
  resetPassword,
  resetTotp,
  suspendUser,
  toSummary,
  unlockUser,
} from '../services/users.js';
import { currentPrincipal, requireAuth, requireRole } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

const userIdSchema = z.object({ id: z.string().uuid() });

/**
 * User administration. Admin only, and the guard is the central one rather
 * than an ad hoc check per handler (doc 01 §3.4).
 */
export function userRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth(), requireRole('admin'));

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const summaries: UserSummary[] = await listUsers(db);
      res.json({ users: summaries });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = createUserRequestSchema.parse(req.body);

      const { user, oneTimePassword } = await createUser(
        db,
        request,
        principal.user.id,
        req.auditActor,
      );

      // Shown once. The admin reads it out or hands it over directly.
      const body: IssuedCredential = { user: toSummary(user), oneTimePassword };
      res.status(201).json(body);
    }),
  );

  router.post(
    '/:id/reset-password',
    asyncHandler(async (req, res) => {
      const { id } = userIdSchema.parse(req.params);
      const { user, oneTimePassword } = await resetPassword(db, id, req.auditActor);
      const body: IssuedCredential = { user: toSummary(user), oneTimePassword };
      res.json(body);
    }),
  );

  router.post(
    '/:id/suspend',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = userIdSchema.parse(req.params);

      // Suspending yourself locks the system's only working admin out of it.
      if (id === principal.user.id) {
        throw new HttpError('conflict', 'You cannot suspend your own account.');
      }

      res.json({ user: await suspendUser(db, id, req.auditActor) });
    }),
  );

  router.post(
    '/:id/reinstate',
    asyncHandler(async (req, res) => {
      const { id } = userIdSchema.parse(req.params);
      res.json({ user: await reinstateUser(db, id, req.auditActor) });
    }),
  );

  router.post(
    '/:id/reset-totp',
    asyncHandler(async (req, res) => {
      const { id } = userIdSchema.parse(req.params);
      res.json({ user: await resetTotp(db, id, req.auditActor) });
    }),
  );

  router.post(
    '/:id/unlock',
    asyncHandler(async (req, res) => {
      const { id } = userIdSchema.parse(req.params);
      res.json({ user: await unlockUser(db, id, req.auditActor) });
    }),
  );

  return router;
}
