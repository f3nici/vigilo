import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  canManageReasonCodes,
  canManageSchedules,
  canRecordChecks,
  createCoverageExceptionRequestSchema,
  createMissedReasonCodeRequestSchema,
  createScheduleRequestSchema,
  editEntryRequestSchema,
  previewScheduleRequestSchema,
  putCoveragePatternRequestSchema,
  putEntryRequestSchema,
  putMissReasonRequestSchema,
  putSegmentsRequestSchema,
  recalculateCoverageRequestSchema,
  updateMissedReasonCodeRequestSchema,
  updateScheduleRequestSchema,
  addDays,
  localDateOf,
  zonedTimeToUtc,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  createSchedule,
  endSchedule,
  findSchedule,
  getSchedule,
  listSchedules,
  previewSchedule,
  putSegments,
  updateSchedule,
} from '../services/schedules.js';
import {
  createCoverageException,
  deleteCoverageException,
  getCoveragePattern,
  listCoverageExceptions,
  putCoveragePattern,
  recalculateCoverage,
} from '../services/coverage.js';
import {
  dueWindows,
  findWindow,
  getWindowDetail,
  listWindows,
  materialiseParticipant,
  regenerateFutureWindows,
  HORIZON_DAYS,
} from '../services/windows.js';
import {
  editEntry,
  getEntry,
  listRevisions,
  putEntry,
  putMissReason,
} from '../services/entries.js';
import { createReasonCode, listReasonCodes, updateReasonCode } from '../services/reasonCodes.js';
import { findParticipant } from '../services/participants.js';
import { assertInScope } from '../services/scope.js';
import { getOrgSettings } from '../services/org.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';
import { coverageExceptions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Capability check for a handler that had to load a row before it could know
 * which participant it belongs to.
 *
 * The order is the point: scope is checked first, so an out-of-scope request
 * answers identically whatever the caller's role and whatever they were about
 * to attempt. Reversing it would leak the org chart through error messages.
 */
function afterScope(req: Request, can: (role: Role) => boolean, message: string): void {
  if (!can(currentPrincipal(req).role)) {
    throw new HttpError('scope_denied', message);
  }
}

const dateRangeSchema = z.object({
  from: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * The participant-scoped half of Phase 3: schedules, coverage and windows
 * (doc 04 §6 and §7). Mounted alongside the Phase 2 participant router so each
 * file stays about one thing.
 */
export function participantCheckRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  const manageSchedules = requireCapability(
    canManageSchedules,
    'Only an admin or a team leader can change schedules and coverage.',
  );

  // Schedules.
  router.get(
    '/:id/schedules',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const includeEnded = req.query.includeEnded === 'true';
      res.json({ schedules: await listSchedules(db, id, { includeEnded }) });
    }),
  );

  router.post(
    '/:id/schedules',
    manageSchedules,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);

      const request = createScheduleRequestSchema.parse(req.body);
      const schedule = await createSchedule(db, id, request, principal.user.id, req.auditActor);

      // Lay the grid immediately. A schedule that produces nothing until the
      // hourly job next fires looks broken to the admin who just saved it.
      const org = await getOrgSettings(db);
      const today = localDateOf(new Date(), org.timezone);
      await materialiseParticipant(db, id, today, addDays(today, HORIZON_DAYS));

      res.status(201).json({ schedule: await getSchedule(db, schedule.id) });
    }),
  );

  /** The live preview. Saves nothing (doc 04 §6). */
  router.post(
    '/:id/schedules/preview',
    manageSchedules,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const request = previewScheduleRequestSchema.parse(req.body);
      const scheduleId = z.string().uuid().optional().parse(req.query.scheduleId) ?? null;
      res.json(await previewSchedule(db, id, request, scheduleId));
    }),
  );

  // Coverage.
  router.get(
    '/:id/coverage-pattern',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      res.json({ pattern: await getCoveragePattern(db, id) });
    }),
  );

  router.put(
    '/:id/coverage-pattern',
    manageSchedules,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = putCoveragePatternRequestSchema.parse(req.body);
      const pattern = await putCoveragePattern(db, id, request, principal.user.id, req.auditActor);
      res.json({ pattern });
    }),
  );

  router.get(
    '/:id/coverage-exceptions',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      res.json({ exceptions: await listCoverageExceptions(db, id) });
    }),
  );

  router.post(
    '/:id/coverage-exceptions',
    manageSchedules,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);
      const request = createCoverageExceptionRequestSchema.parse(req.body);
      const exception = await createCoverageException(
        db,
        id,
        request,
        principal.user.id,
        req.auditActor,
      );
      res.status(201).json({ exception });
    }),
  );

  /**
   * Recalculation (doc 04 §6). Defaults to a preview: this can rewrite
   * compliance history, so it says what it would do before it does it.
   */
  router.post(
    '/:id/coverage/recalculate',
    manageSchedules,
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const request = recalculateCoverageRequestSchema.parse(req.body);
      res.json(await recalculateCoverage(db, id, request, req.auditActor));
    }),
  );

  // Windows. Read by anyone in scope, because recording checks is the job.
  router.get(
    '/:id/windows',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const org = await getOrgSettings(db);
      const range = dateRangeSchema.parse(req.query);

      const today = localDateOf(new Date(), org.timezone);
      const from = range.from ?? today;
      const to = range.to ?? addDays(today, 1);

      const windows = await listWindows(
        db,
        keyRing,
        id,
        zonedTimeToUtc(from, 0, org.timezone),
        zonedTimeToUtc(to, 24 * 60, org.timezone),
      );
      res.json({ windows, timeZone: org.timezone });
    }),
  );

  return router;
}

/** Schedules addressed by their own id (doc 04 §6). */
export function scheduleRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedSchedule(req: Request): Promise<{ id: string; participantId: string }> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const schedule = await findSchedule(db, id);
    assertInScope(principal.scope, schedule.participantId);
    return { id, participantId: schedule.participantId };
  }

  const DENIED = 'Only an admin or a team leader can change schedules and coverage.';

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = await scopedSchedule(req);
      res.json({ schedule: await getSchedule(db, id) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = await scopedSchedule(req);
      afterScope(req, canManageSchedules, DENIED);
      const request = updateScheduleRequestSchema.parse(req.body);
      const schedule = await updateSchedule(db, id, request, req.auditActor);
      const regenerated = await regenerateFutureWindows(db, id);
      res.json({ schedule, regenerated });
    }),
  );

  /** Replaces the whole segment set, then rebuilds the remaining windows. */
  router.put(
    '/:id/segments',
    asyncHandler(async (req, res) => {
      const { id } = await scopedSchedule(req);
      afterScope(req, canManageSchedules, DENIED);
      const request = putSegmentsRequestSchema.parse(req.body);
      const schedule = await putSegments(db, id, request, req.auditActor);
      const regenerated = await regenerateFutureWindows(db, id);
      res.json({ schedule, regenerated });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = await scopedSchedule(req);
      afterScope(req, canManageSchedules, DENIED);
      const schedule = await endSchedule(db, id, req.auditActor);
      const regenerated = await regenerateFutureWindows(db, id);
      res.json({ schedule, regenerated });
    }),
  );

  return router;
}

/** Windows, entries and miss reasons (doc 04 §7). */
export function windowRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedWindow(req: Request): Promise<string> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const window = await findWindow(db, id);
    assertInScope(principal.scope, window.participantId);
    return id;
  }

  const RECORD_DENIED = 'A self-access account cannot record checks.';

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = await scopedWindow(req);
      res.json({ window: await getWindowDetail(db, keyRing, id) });
    }),
  );

  router.put(
    '/:id/entry',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = await scopedWindow(req);
      afterScope(req, canRecordChecks, RECORD_DENIED);

      const request = putEntryRequestSchema.parse(req.body);
      const { entry } = await putEntry(
        db,
        keyRing,
        id,
        request,
        { userId: principal.user.id, role: principal.role, deviceId: null },
        req.auditActor,
      );

      res.json({ entry, window: await getWindowDetail(db, keyRing, id) });
    }),
  );

  router.put(
    '/:id/miss-reason',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = await scopedWindow(req);
      afterScope(req, canRecordChecks, RECORD_DENIED);

      const request = putMissReasonRequestSchema.parse(req.body);
      const missReason = await putMissReason(
        db,
        keyRing,
        id,
        request,
        { userId: principal.user.id, role: principal.role, deviceId: null },
        req.auditActor,
      );

      res.json({ missReason, window: await getWindowDetail(db, keyRing, id) });
    }),
  );

  return router;
}

export function checkEntryRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedEntry(req: Request): Promise<string> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const entry = await getEntry(db, id);
    assertInScope(principal.scope, entry.participantId);
    return id;
  }

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = await scopedEntry(req);
      afterScope(req, canRecordChecks, 'A self-access account cannot change records.');

      const request = editEntryRequestSchema.parse(req.body);
      const { entry, window } = await editEntry(
        db,
        keyRing,
        id,
        request,
        { userId: principal.user.id, role: principal.role, deviceId: null },
        req.auditActor,
      );

      res.json({ entry, window: await getWindowDetail(db, keyRing, window.id) });
    }),
  );

  router.get(
    '/:id/revisions',
    asyncHandler(async (req, res) => {
      const id = await scopedEntry(req);
      res.json({ revisions: await listRevisions(db, keyRing, id) });
    }),
  );

  return router;
}

export function coverageExceptionRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = idSchema.parse(req.params);

      const [row] = await db
        .select({ participantId: coverageExceptions.participantId })
        .from(coverageExceptions)
        .where(eq(coverageExceptions.id, id))
        .limit(1);
      if (!row) throw new HttpError('not_found', 'That coverage exception does not exist.');

      assertInScope(principal.scope, row.participantId);
      afterScope(
        req,
        canManageSchedules,
        'Only an admin or a team leader can change schedules and coverage.',
      );

      await deleteCoverageException(db, row.participantId, id, req.auditActor);
      res.status(204).end();
    }),
  );

  return router;
}

/** Admin-configurable reason codes (doc 04 §12). */
export function reasonCodeRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  const manageCodes = requireCapability(
    canManageReasonCodes,
    'Only an admin can change the missed-check reasons.',
  );

  // Every staff role reads them, because that is the list a worker picks from.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const includeInactive = req.query.includeInactive === 'true';
      res.json({ reasonCodes: await listReasonCodes(db, { includeInactive }) });
    }),
  );

  router.post(
    '/',
    manageCodes,
    asyncHandler(async (req, res) => {
      const request = createMissedReasonCodeRequestSchema.parse(req.body);
      res.status(201).json({ reasonCode: await createReasonCode(db, request, req.auditActor) });
    }),
  );

  router.patch(
    '/:id',
    manageCodes,
    asyncHandler(async (req, res) => {
      const { id } = idSchema.parse(req.params);
      const request = updateMissedReasonCodeRequestSchema.parse(req.body);
      res.json({ reasonCode: await updateReasonCode(db, id, request, req.auditActor) });
    }),
  );

  return router;
}

/**
 * The Today screen's feed: every window across the caller's own participants,
 * closing soon or recently closed (doc 04 §7). Scoped by the resolver, so a
 * worker's Today is exactly their assigned participants and nothing else.
 */
export function myWindowRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/windows/due',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const within = z.coerce.number().int().min(0).max(10_080).optional().parse(req.query.within);
      const org = await getOrgSettings(db);

      const windows = await dueWindows(
        db,
        keyRing,
        principal.scope.kind === 'all' ? 'all' : principal.scope.participantIds,
        within === undefined ? {} : { withinMinutes: within },
      );

      res.json({ windows, timeZone: org.timezone });
    }),
  );

  return router;
}
