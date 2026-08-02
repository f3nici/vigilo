import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  canEditAlerts,
  canEditContacts,
  canGrantAccess,
  canManageParticipants,
  canWriteEmergencyPlan,
  createAlertRequestSchema,
  createAssignmentRequestSchema,
  setSupportTeamRequestSchema,
  createContactRequestSchema,
  createParticipantRequestSchema,
  ndisNumberSchema,
  putEmergencyPlanRequestSchema,
  updateAlertRequestSchema,
  updateContactRequestSchema,
  updateParticipantRequestSchema,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  archiveParticipant,
  createParticipant,
  findParticipant,
  getParticipantDetail,
  listParticipants,
  lookupByNdisNumber,
  restoreParticipant,
  updateParticipant,
} from '../services/participants.js';
import { createAlert, deactivateAlert, listAlerts, updateAlert } from '../services/alerts.js';
import {
  createContact,
  deleteContact,
  getEmergencyPlan,
  listContacts,
  putEmergencyPlan,
  updateContact,
} from '../services/contacts.js';
import {
  grantAssignment,
  listAssignableStaff,
  listAssignments,
  setSupportTeam,
} from '../services/assignments.js';
import { assertInScope } from '../services/scope.js';
import { recordParticipantView } from '../services/audit.js';
import {
  accessTo,
  currentPrincipal,
  requireAuth,
  requireCapability,
} from '../middleware/principal.js';
import { asyncHandler } from '../middleware/async.js';

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Participants (doc 04 §3 and §4).
 *
 * Two checks run on every route that names a participant, in this order:
 * scope, then capability. Scope first is deliberate, because an out-of-scope
 * request must answer the same way whether or not the record exists, and it
 * must not depend on what the caller was going to try to do with it.
 */
export function participantRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  /**
   * Resolves `:id`, refuses anything out of scope, and returns it. Every
   * handler below starts here rather than reading `req.params` itself.
   */
  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  const manageParticipants = requireCapability(
    canManageParticipants,
    'Only an admin can change participant records.',
  );
  const editAlerts = requireCapability(
    canEditAlerts,
    'Only an admin or a nurse can change alerts.',
  );
  const editContacts = requireCapability(
    canEditContacts,
    'Only an admin can change emergency contacts.',
  );
  const writePlan = requireCapability(
    canWriteEmergencyPlan,
    'Only an admin or a nurse can change an emergency plan.',
  );
  const grantAccess = requireCapability(
    canGrantAccess,
    'Only an admin or a team leader can change who has access.',
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const includeArchived = req.query.includeArchived === 'true';

      const summaries = await listParticipants(
        db,
        keyRing,
        principal.scope.kind === 'all' ? 'all' : principal.scope.participantIds,
        principal.access,
        { includeArchived },
      );

      res.json({ participants: summaries });
    }),
  );

  router.post(
    '/',
    manageParticipants,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const request = createParticipantRequestSchema.parse(req.body);
      const participant = await createParticipant(
        db,
        keyRing,
        request,
        principal.user.id,
        req.auditActor,
      );
      res.status(201).json({ participant });
    }),
  );

  /**
   * Exact match on the NDIS blind index, so an admin can find someone without
   * the server decrypting the whole table. Declared before `/:id` so the word
   * "lookup" is never read as an id.
   */
  router.get(
    '/lookup',
    manageParticipants,
    asyncHandler(async (req, res) => {
      const { ndis } = z.object({ ndis: ndisNumberSchema }).parse(req.query);
      const participant = await lookupByNdisNumber(db, keyRing, ndis, req.auditActor);
      res.json({ participant });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);

      const participant = await getParticipantDetail(db, keyRing, id, accessTo(principal, id));

      // Opening a record is logged, batched per 15 minutes (doc 07 §4).
      await recordParticipantView(db, req.auditActor, id);

      res.json({ participant });
    }),
  );

  router.patch(
    '/:id',
    manageParticipants,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const request = updateParticipantRequestSchema.parse(req.body);
      res.json({ participant: await updateParticipant(db, keyRing, id, request, req.auditActor) });
    }),
  );

  /** Archive, never delete. The row and its history stay (doc 01 §4). */
  router.post(
    '/:id/archive',
    manageParticipants,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      res.json({ participant: await archiveParticipant(db, keyRing, id, req.auditActor) });
    }),
  );

  router.post(
    '/:id/restore',
    manageParticipants,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      res.json({ participant: await restoreParticipant(db, keyRing, id, req.auditActor) });
    }),
  );

  // Alerts. Everyone in scope reads them, because an unread allergy flag is the
  // point of failure this feature exists to prevent.
  router.get(
    '/:id/alerts',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const alerts = await listAlerts(db, keyRing, id, {
        includeInactive: canEditAlerts(principal.role),
      });
      res.json({ alerts });
    }),
  );

  router.post(
    '/:id/alerts',
    editAlerts,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createAlertRequestSchema.parse(req.body);
      const alert = await createAlert(db, keyRing, id, request, principal.user.id, req.auditActor);
      res.status(201).json({ alert });
    }),
  );

  router.patch(
    '/:id/alerts/:alertId',
    editAlerts,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const { alertId } = z.object({ alertId: z.string().uuid() }).parse(req.params);
      const request = updateAlertRequestSchema.parse(req.body);
      res.json({ alert: await updateAlert(db, keyRing, id, alertId, request, req.auditActor) });
    }),
  );

  router.delete(
    '/:id/alerts/:alertId',
    editAlerts,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const { alertId } = z.object({ alertId: z.string().uuid() }).parse(req.params);
      res.json({ alert: await deactivateAlert(db, keyRing, id, alertId, req.auditActor) });
    }),
  );

  // Emergency contacts.
  router.get(
    '/:id/contacts',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      res.json({ contacts: await listContacts(db, keyRing, id) });
    }),
  );

  router.post(
    '/:id/contacts',
    editContacts,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createContactRequestSchema.parse(req.body);
      res
        .status(201)
        .json({ contact: await createContact(db, keyRing, id, request, req.auditActor) });
    }),
  );

  router.patch(
    '/:id/contacts/:contactId',
    editContacts,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const { contactId } = z.object({ contactId: z.string().uuid() }).parse(req.params);
      const request = updateContactRequestSchema.parse(req.body);
      res.json({
        contact: await updateContact(db, keyRing, id, contactId, request, req.auditActor),
      });
    }),
  );

  router.delete(
    '/:id/contacts/:contactId',
    editContacts,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const { contactId } = z.object({ contactId: z.string().uuid() }).parse(req.params);
      await deleteContact(db, id, contactId, req.auditActor);
      res.status(204).end();
    }),
  );

  // The emergency plan. Read by anyone in scope, written by admins and nurses.
  router.get(
    '/:id/emergency-plan',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      res.json({ emergencyPlan: await getEmergencyPlan(db, keyRing, id) });
    }),
  );

  router.put(
    '/:id/emergency-plan',
    writePlan,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = putEmergencyPlanRequestSchema.parse(req.body);
      const emergencyPlan = await putEmergencyPlan(
        db,
        keyRing,
        id,
        request,
        principal.user.id,
        req.auditActor,
      );
      res.json({ emergencyPlan });
    }),
  );

  // Assignments. A team leader grants within their own scope, which the scope
  // check above already enforces.
  router.get(
    '/:id/assignments',
    grantAccess,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      res.json({ assignments: await listAssignments(db, id) });
    }),
  );

  router.post(
    '/:id/assignments',
    grantAccess,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createAssignmentRequestSchema.parse(req.body);
      const assignment = await grantAssignment(db, id, request, principal.user.id, req.auditActor);
      res.status(201).json({ assignment });
    }),
  );

  /*
   * The support team (D87). Who could be on it, and setting the whole ongoing
   * list in one write.
   *
   * Behind `grantAccess` rather than admin-only, which is what makes the screen
   * usable by a team leader: they have always been allowed to grant access and
   * have never been able to see who to grant it to.
   */
  router.get(
    '/:id/support-team',
    grantAccess,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      await findParticipant(db, id);
      res.json({ staff: await listAssignableStaff(db, id) });
    }),
  );

  router.put(
    '/:id/support-team',
    grantAccess,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = setSupportTeamRequestSchema.parse(req.body);
      const change = await setSupportTeam(
        db,
        id,
        request.userIds,
        principal.user.id,
        req.auditActor,
      );
      res.json({ change, staff: await listAssignableStaff(db, id) });
    }),
  );

  return router;
}
