import { Router } from 'express';
import { z } from 'zod';
import { pushSubscriptionRequestSchema, updateNotificationPreferencesSchema } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  deleteSubscription,
  getPreferences,
  isConfigured,
  saveSubscription,
  updatePreferences,
  type VapidKeys,
} from '../services/push.js';
import { currentPrincipal, requireAuth } from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Push subscriptions (doc 04 §14).
 *
 * The same endpoints serve FCM and APNs in the native phases. A subscription
 * is a device plus an address to reach it at, and nothing in these shapes is
 * specific to a browser.
 */
export function pushRoutes(db: Database, keys: VapidKeys | null): Router {
  const router = Router();

  router.use(requireAuth());

  /**
   * The public half of the VAPID pair, which the service worker subscribes
   * with. `configured: false` is a real answer: a deployment with no keys
   * should have the app quietly not offer notifications rather than fail.
   */
  router.get('/vapid-key', (_req, res) => {
    res.json({
      configured: isConfigured(keys),
      publicKey: isConfigured(keys) ? keys.publicKey : null,
    });
  });

  router.post(
    '/subscriptions',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = pushSubscriptionRequestSchema.parse(req.body);
      res.status(201).json(await saveSubscription(db, principal.user.id, request));
    }),
  );

  router.delete(
    '/subscriptions/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await deleteSubscription(db, principal.user.id, id);
      res.status(204).end();
    }),
  );

  return router;
}

/** Per-kind toggles, on the caller's own account only. */
export function notificationPreferenceRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/notification-preferences',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      res.json({ preferences: await getPreferences(db, principal.user.id) });
    }),
  );

  router.put(
    '/notification-preferences',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = updateNotificationPreferencesSchema.parse(req.body);
      res.json({ preferences: await updatePreferences(db, principal.user.id, request) });
    }),
  );

  return router;
}
