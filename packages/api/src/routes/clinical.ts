import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  canReadCarePlans,
  canWriteCarePlans,
  canRaiseIncident,
  closeIncidentRequestSchema,
  completeIncidentActionRequestSchema,
  createCarePlanRequestSchema,
  createIncidentActionRequestSchema,
  createIncidentRequestSchema,
  incidentQuerySchema,
  markCarePlanReadRequestSchema,
  publishCarePlanVersionRequestSchema,
  reopenIncidentRequestSchema,
  updateCarePlanRequestSchema,
  updateCarePlanVersionRequestSchema,
  updateIncidentRequestSchema,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  createCarePlan,
  discardDraft,
  draftFor,
  findCarePlanRow,
  findVersionRow,
  getCarePlan,
  listCarePlanVersions,
  listCarePlans,
  markRead,
  publishVersion,
  readReceipts,
  updateCarePlan,
  updateVersion,
} from '../services/careplans.js';
import {
  addAction,
  closeIncident,
  completeAction,
  createIncident,
  findIncidentRow,
  getIncident,
  listIncidents,
  recentIncidents,
  reopenIncident,
  updateIncident,
} from '../services/incidents.js';
import { renderIncident } from '../services/pdf.js';
import { notifyCarePlanPublished } from '../services/notifications.js';
import { findParticipant, toSummary } from '../services/participants.js';
import { assertInScope } from '../services/scope.js';
import { getOrgSettings } from '../services/org.js';
import { recordAudit } from '../services/audit.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';
import { incidentActions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { VapidKeys } from '../services/push.js';

/**
 * Care plans and incidents (doc 04 §10).
 *
 * Split from the medication router so each file stays about one thing, and
 * scope is checked before the role capability everywhere, so an out-of-scope
 * request answers identically whatever the caller was about to attempt.
 */

const idSchema = z.object({ id: z.string().uuid() });

function afterScope(req: Request, can: (role: Role) => boolean, message: string): void {
  if (!can(currentPrincipal(req).role)) {
    throw new HttpError('scope_denied', message);
  }
}

const WRITE_DENIED = 'Only an admin or a nurse can write a care plan.';
const READ_DENIED = 'A self-access account reads its own record another way.';

/* -------------------------------------------------------------- care plans */

/** Care plans hanging off a participant (doc 04 §10). */
export function participantCarePlanRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  const write = requireCapability(canWriteCarePlans, WRITE_DENIED);

  router.get(
    '/:id/care-plans',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      afterScope(req, canReadCarePlans, READ_DENIED);

      const includeArchived = req.query.includeArchived === 'true';
      res.json({
        carePlans: await listCarePlans(
          db,
          keyRing,
          id,
          { userId: principal.user.id, role: principal.role },
          { includeArchived },
        ),
      });
    }),
  );

  router.post(
    '/:id/care-plans',
    write,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);

      const request = createCarePlanRequestSchema.parse(req.body);
      const carePlan = await createCarePlan(
        db,
        keyRing,
        id,
        request,
        { userId: principal.user.id, role: principal.role },
        req.auditActor,
      );

      res.status(201).json({ carePlan });
    }),
  );

  return router;
}

/** A care plan addressed by its own id (doc 04 §10). */
export function carePlanRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedPlan(req: Request): Promise<{ id: string; participantId: string }> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const plan = await findCarePlanRow(db, id);
    assertInScope(principal.scope, plan.participantId);
    afterScope(req, canReadCarePlans, READ_DENIED);
    return { id, participantId: plan.participantId };
  }

  function context(req: Request) {
    const principal = currentPrincipal(req);
    return { userId: principal.user.id, role: principal.role };
  }

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id, participantId } = await scopedPlan(req);

      /*
       * Reading a care plan is a view of a participant's record, so it is
       * audited as one (doc 07 §4). "Who has read this plan" is a question an
       * access review asks, and it cannot be answered from write records.
       */
      await recordAudit(db, {
        action: 'care_plan.view',
        actor: req.auditActor,
        entityType: 'care_plan',
        entityId: id,
        participantId,
      });

      res.json({ carePlan: await getCarePlan(db, keyRing, id, context(req)) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = await scopedPlan(req);
      afterScope(req, canWriteCarePlans, WRITE_DENIED);

      const request = updateCarePlanRequestSchema.parse(req.body);
      res.json({
        carePlan: await updateCarePlan(db, keyRing, id, request, context(req), req.auditActor),
      });
    }),
  );

  /** The whole history. Authors only: a worker reads what applies now. */
  router.get(
    '/:id/versions',
    asyncHandler(async (req, res) => {
      const { id } = await scopedPlan(req);
      afterScope(req, canWriteCarePlans, WRITE_DENIED);
      res.json({ versions: await listCarePlanVersions(db, keyRing, id) });
    }),
  );

  /**
   * The draft to edit, created from what is published if there is not one yet.
   * A PUT rather than a POST: asking twice gets the same draft.
   */
  router.put(
    '/:id/draft',
    asyncHandler(async (req, res) => {
      const { id } = await scopedPlan(req);
      afterScope(req, canWriteCarePlans, WRITE_DENIED);

      const draft = await draftFor(db, keyRing, id);
      const versions = await listCarePlanVersions(db, keyRing, id);
      res.json({ draft: versions.find((one) => one.id === draft.id) ?? null });
    }),
  );

  router.get(
    '/:id/read-receipts',
    asyncHandler(async (req, res) => {
      const { id } = await scopedPlan(req);
      afterScope(req, canWriteCarePlans, WRITE_DENIED);
      res.json({ receipts: await readReceipts(db, id) });
    }),
  );

  /** A read receipt, which clears the unread marker (doc 01 §7.1). */
  router.post(
    '/:id/read',
    asyncHandler(async (req, res) => {
      const { id } = await scopedPlan(req);
      const request = markCarePlanReadRequestSchema.parse(req.body);
      const { versionId } = await markRead(db, id, request, context(req), req.auditActor);
      res.json({ versionId, carePlan: await getCarePlan(db, keyRing, id, context(req)) });
    }),
  );

  return router;
}

/** A version addressed by its own id: edit a draft, publish it, discard it. */
export function carePlanVersionRoutes(
  db: Database,
  keyRing: KeyRing,
  vapid: VapidKeys | null,
): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedVersion(req: Request): Promise<string> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const version = await findVersionRow(db, id);
    const plan = await findCarePlanRow(db, version.carePlanId);
    assertInScope(principal.scope, plan.participantId);
    afterScope(req, canWriteCarePlans, WRITE_DENIED);
    return id;
  }

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = await scopedVersion(req);
      const request = updateCarePlanVersionRequestSchema.parse(req.body);
      res.json({ versions: await updateVersion(db, keyRing, id, request, req.auditActor) });
    }),
  );

  /**
   * Publishing notifies every assigned worker and sets the unread marker
   * (doc 01 §7.1, §9). The notification carries the participant's initial and
   * surname and a link, never what changed.
   */
  router.post(
    '/:id/publish',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = await scopedVersion(req);
      const request = publishCarePlanVersionRequestSchema.parse(req.body);

      const { plan, participantId, carePlanId } = await publishVersion(
        db,
        keyRing,
        id,
        request,
        { userId: principal.user.id, role: principal.role },
        req.auditActor,
      );

      const notified = await notifyCarePlanPublished(db, keyRing, vapid, {
        participantId,
        carePlanId,
        versionId: id,
      });

      res.json({ carePlan: plan, notified });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = await scopedVersion(req);
      await discardDraft(db, id, req.auditActor);
      res.status(204).end();
    }),
  );

  return router;
}

/* --------------------------------------------------------------- incidents */

const RAISE_DENIED = 'Incidents are not part of your record.';

/** Incidents hanging off a participant (doc 04 §10). */
export function participantIncidentRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  function context(req: Request) {
    const principal = currentPrincipal(req);
    return { userId: principal.user.id, role: principal.role };
  }

  router.get(
    '/:id/incidents',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      afterScope(req, canRaiseIncident, RAISE_DENIED);

      const query = incidentQuerySchema.parse(req.query);
      const org = await getOrgSettings(db);

      const list = await listIncidents(db, keyRing, id, query, context(req), org.timezone);

      // Reading incident narratives is a view of a participant's record.
      await recordAudit(db, {
        action: 'incident.view_list',
        actor: req.auditActor,
        entityType: 'participant',
        entityId: id,
        participantId: id,
        metadata: { count: list.length },
      });

      res.json({ incidents: list, timeZone: org.timezone });
    }),
  );

  router.post(
    '/:id/incidents',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      afterScope(req, canRaiseIncident, RAISE_DENIED);
      await findParticipant(db, id);

      const request = createIncidentRequestSchema.parse(req.body);
      const incident = await createIncident(db, keyRing, id, request, context(req), req.auditActor);

      res.status(201).json({ incident });
    }),
  );

  return router;
}

/** An incident addressed by its own id (doc 04 §10). */
export function incidentRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedIncident(req: Request): Promise<{ id: string; participantId: string }> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const incident = await findIncidentRow(db, id);
    assertInScope(principal.scope, incident.participantId);
    afterScope(req, canRaiseIncident, RAISE_DENIED);
    return { id, participantId: incident.participantId };
  }

  function context(req: Request) {
    const principal = currentPrincipal(req);
    return { userId: principal.user.id, role: principal.role };
  }

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id, participantId } = await scopedIncident(req);

      await recordAudit(db, {
        action: 'incident.view',
        actor: req.auditActor,
        entityType: 'incident',
        entityId: id,
        participantId,
      });

      res.json({ incident: await getIncident(db, keyRing, id, context(req)) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = await scopedIncident(req);
      const request = updateIncidentRequestSchema.parse(req.body);
      res.json({
        incident: await updateIncident(db, keyRing, id, request, context(req), req.auditActor),
      });
    }),
  );

  router.post(
    '/:id/close',
    asyncHandler(async (req, res) => {
      const { id } = await scopedIncident(req);
      const request = closeIncidentRequestSchema.parse(req.body);
      res.json(await closeIncident(db, keyRing, id, request, context(req), req.auditActor));
    }),
  );

  router.post(
    '/:id/reopen',
    asyncHandler(async (req, res) => {
      const { id } = await scopedIncident(req);
      const request = reopenIncidentRequestSchema.parse(req.body);
      res.json({
        incident: await reopenIncident(db, keyRing, id, request, context(req), req.auditActor),
      });
    }),
  );

  router.post(
    '/:id/actions',
    asyncHandler(async (req, res) => {
      const { id } = await scopedIncident(req);
      const request = createIncidentActionRequestSchema.parse(req.body);
      res.status(201).json({
        incident: await addAction(db, keyRing, id, request, context(req), req.auditActor),
      });
    }),
  );

  /** The PDF (doc 01 §7.3). Streamed, like the daily report. */
  router.get(
    '/:id/pdf',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id, participantId } = await scopedIncident(req);

      const incident = await getIncident(db, keyRing, id, context(req));
      const org = await getOrgSettings(db);
      const participant = toSummary(keyRing, await findParticipant(db, participantId));

      await recordAudit(db, {
        action: 'incident.export_pdf',
        actor: req.auditActor,
        entityType: 'incident',
        entityId: id,
        participantId,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vigilo-incident-${incident.occurredAt.slice(0, 10)}.pdf"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');

      renderIncident(incident, {
        participantName: `${participant.firstName} ${participant.lastName}`,
        orgName: org.orgName,
        timeZone: org.timezone,
        generatedAt: new Date().toISOString(),
        generatedByName: principal.user.displayName,
      }).pipe(res);
    }),
  );

  return router;
}

/** A follow-up action addressed by its own id. */
export function incidentActionRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  router.post(
    '/:id/complete',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = idSchema.parse(req.params);

      const [action] = await db
        .select({ incidentId: incidentActions.incidentId })
        .from(incidentActions)
        .where(eq(incidentActions.id, id))
        .limit(1);
      if (!action) throw new HttpError('not_found', 'That follow-up action does not exist.');

      const incident = await findIncidentRow(db, action.incidentId);
      assertInScope(principal.scope, incident.participantId);
      afterScope(req, canRaiseIncident, RAISE_DENIED);

      const request = completeIncidentActionRequestSchema.parse(req.body);
      res.json({
        incident: await completeAction(
          db,
          keyRing,
          id,
          request,
          { userId: principal.user.id, role: principal.role },
          req.auditActor,
        ),
      });
    }),
  );

  return router;
}

/** Recent incidents across everything the caller can see (doc 06 §5). */
export function myIncidentRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/incidents/recent',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      afterScope(req, canRaiseIncident, RAISE_DENIED);

      const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit);
      const list = await recentIncidents(
        db,
        keyRing,
        principal.scope.kind === 'all' ? 'all' : principal.scope.participantIds,
        { userId: principal.user.id, role: principal.role },
        limit,
      );

      res.json({ incidents: list });
    }),
  );

  return router;
}
