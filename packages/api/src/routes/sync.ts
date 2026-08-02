import { Router, type Request } from 'express';
import {
  canSyncOffline,
  registerDeviceRequestSchema,
  syncChangesQuerySchema,
  syncPushRequestSchema,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import { applyOperations, bootstrap, changesSince, type SyncPrincipal } from '../services/sync.js';
import { getDevice, recordSyncCursor, registerDevice } from '../services/devices.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Sync (doc 04 §13).
 *
 * Three endpoints and no scope checks in this file, which is the point. Scope
 * is resolved inside the sync service from the same resolver every other route
 * uses, and it is applied as a WHERE clause rather than as a filter over rows
 * already read. There is no participant id in any of these URLs to check.
 */

function syncPrincipal(req: Request): SyncPrincipal {
  const principal = currentPrincipal(req);
  return {
    userId: principal.user.id,
    role: principal.role,
    participantId: principal.user.participantId,
    deviceId: req.auditActor.deviceId,
  };
}

export function syncRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());
  /*
   * A self-access account gets nothing on a device. The middleware above every
   * router already refuses these paths for that role; this says it here as
   * well, because it is a property of sync rather than of the URL. The feed is
   * scoped by participant, not by field, so a participant device would pull
   * whole rows including the diary entries staff marked not visible and the
   * checks nobody recorded.
   */
  router.use(
    requireCapability(canSyncOffline, 'A self-access account does not keep records on a device.'),
  );

  /**
   * The full scoped snapshot. Called by a new device, after a reinstall, when
   * the device detects its local database was evicted, and when it finds the
   * server's revision below its own cursor after a database restore.
   */
  router.get(
    '/bootstrap',
    asyncHandler(async (req, res) => {
      const principal = syncPrincipal(req);
      const snapshot = await bootstrap(db, keyRing, principal);
      await recordSyncCursor(db, principal.deviceId, principal.userId, snapshot.revision);
      res.json(snapshot);
    }),
  );

  router.get(
    '/changes',
    asyncHandler(async (req, res) => {
      const principal = syncPrincipal(req);
      const { since, limit } = syncChangesQuerySchema.parse(req.query);
      const page = await changesSince(db, keyRing, principal, since, limit);
      await recordSyncCursor(db, principal.deviceId, principal.userId, page.nextRevision);
      res.json(page);
    }),
  );

  /**
   * The outbox draining.
   *
   * Always 200 with a per-operation result, even when every operation was
   * rejected. A transport-level failure means "retry the batch"; a rejected
   * operation means "this one will never work, show it to someone". Collapsing
   * the two into an HTTP status would make the device retry a record it can
   * never send, forever.
   */
  router.post(
    '/push',
    asyncHandler(async (req, res) => {
      const principal = syncPrincipal(req);
      const request = syncPushRequestSchema.parse(req.body);
      const { results, serverRevision } = await applyOperations(
        db,
        keyRing,
        principal,
        request.operations,
        req.auditActor,
      );
      res.json({ results, serverRevision, serverTime: new Date().toISOString() });
    }),
  );

  return router;
}

/** Device registration (doc 03 §2). The id is the device's, not ours. */
export function deviceRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = registerDeviceRequestSchema.parse(req.body);
      res.json({ device: await registerDevice(db, principal.user.id, request) });
    }),
  );

  /**
   * How the device learns it has been told to wipe. There is no way to reach a
   * device directly, so the flag waits here until it next makes contact
   * (doc 03 §2).
   */
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      res.json({ device: await getDevice(db, String(req.params.id), principal.user.id) });
    }),
  );

  return router;
}
