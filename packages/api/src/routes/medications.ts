import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  addDays,
  canManageMedications,
  canSignOffMedication,
  createMedicationRequestSchema,
  localDateOf,
  putMedicationSchedulesRequestSchema,
  recordPrnRequestSchema,
  signOffRequestSchema,
  updateAdministrationRequestSchema,
  updateMedicationRequestSchema,
  zonedTimeToUtc,
  MEDICATION_HORIZON_DAYS,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  createMedication,
  findMedicationRow,
  getMedication,
  listColleagues,
  listMedications,
  putMedicationSchedules,
  updateMedication,
} from '../services/medications.js';
import {
  administrationsFor,
  dueDoses,
  findDose,
  getAdministration,
  listDoses,
  materialiseMedication,
  recordPrn,
  regenerateFutureDoses,
  signOffDose,
  updateAdministrationOutcome,
} from '../services/doses.js';
import { findParticipant } from '../services/participants.js';
import { assertInScope } from '../services/scope.js';
import { getOrgSettings } from '../services/org.js';
import { currentPrincipal, requireAuth, requireCapability } from '../middleware/principal.js';
import { HttpError } from '../middleware/errors.js';
import { asyncHandler } from '../middleware/async.js';

/**
 * Medications, doses and sign-offs (doc 04 §10).
 *
 * Split the same way the check routes are: what hangs off a participant, what
 * is addressed by a medication id, and what a worker does to a dose. Scope is
 * always checked before the role capability, so an out-of-scope request answers
 * identically whatever the caller was about to attempt.
 */

const idSchema = z.object({ id: z.string().uuid() });

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

function afterScope(req: Request, can: (role: Role) => boolean, message: string): void {
  if (!can(currentPrincipal(req).role)) {
    throw new HttpError('scope_denied', message);
  }
}

const MANAGE_DENIED = 'Only an admin or a nurse can change medications.';
const SIGN_OFF_DENIED = 'A self-access account cannot sign off medication.';

/** Everything hanging off a participant (doc 04 §10). */
export function participantMedicationRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  function scoped(req: Request): string {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    assertInScope(principal.scope, id);
    return id;
  }

  const manage = requireCapability(canManageMedications, MANAGE_DENIED);

  router.get(
    '/:id/medications',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const includeInactive = req.query.includeInactive === 'true';
      res.json({ medications: await listMedications(db, keyRing, id, { includeInactive }) });
    }),
  );

  router.post(
    '/:id/medications',
    manage,
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      await findParticipant(db, id);

      const request = createMedicationRequestSchema.parse(req.body);
      const medication = await createMedication(
        db,
        keyRing,
        id,
        request,
        principal.user.id,
        req.auditActor,
      );

      res.status(201).json({ medication });
    }),
  );

  router.get(
    '/:id/medication-doses',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const org = await getOrgSettings(db);
      const range = dateRangeSchema.parse(req.query);

      const today = localDateOf(new Date(), org.timezone);
      const from = range.from ?? today;
      const to = range.to ?? addDays(today, 1);

      const doses = await listDoses(
        db,
        keyRing,
        id,
        zonedTimeToUtc(from, 0, org.timezone),
        zonedTimeToUtc(to, 24 * 60, org.timezone),
      );
      res.json({ doses, timeZone: org.timezone });
    }),
  );

  router.get(
    '/:id/medication-administrations',
    asyncHandler(async (req, res) => {
      const id = scoped(req);
      const org = await getOrgSettings(db);
      const range = dateRangeSchema.parse(req.query);

      const today = localDateOf(new Date(), org.timezone);
      const from = range.from ?? addDays(today, -7);
      const to = range.to ?? addDays(today, 1);

      res.json({
        administrations: await administrationsFor(
          db,
          keyRing,
          id,
          zonedTimeToUtc(from, 0, org.timezone),
          zonedTimeToUtc(to, 24 * 60, org.timezone),
        ),
        timeZone: org.timezone,
      });
    }),
  );

  /** A PRN dose, which has no due time to sign off against (doc 01 §7.2). */
  router.post(
    '/:id/medication-administrations',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = scoped(req);
      afterScope(req, canSignOffMedication, SIGN_OFF_DENIED);

      const request = recordPrnRequestSchema.parse(req.body);
      const administration = await recordPrn(
        db,
        keyRing,
        id,
        request,
        {
          userId: principal.user.id,
          role: principal.role,
          deviceId: req.auditActor.deviceId,
        },
        req.auditActor,
      );

      res.status(201).json({ administration });
    }),
  );

  return router;
}

/** Medications addressed by their own id (doc 04 §10). */
export function medicationRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedMedication(req: Request): Promise<string> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const medication = await findMedicationRow(db, id);
    assertInScope(principal.scope, medication.participantId);
    return id;
  }

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = await scopedMedication(req);
      res.json({ medication: await getMedication(db, keyRing, id) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = await scopedMedication(req);
      afterScope(req, canManageMedications, MANAGE_DENIED);

      const request = updateMedicationRequestSchema.parse(req.body);
      const medication = await updateMedication(db, keyRing, id, request, req.auditActor);

      // Stopping a medication, or moving its dates, changes what is due from
      // now on. Rebuilding straight away means the phone stops asking for a
      // dose that is no longer prescribed rather than waiting for the hourly
      // job to notice.
      const regenerated = await regenerateFutureDoses(db, id);

      res.json({ medication, regenerated });
    }),
  );

  /** Replaces the whole set of due times, then rebuilds the remaining doses. */
  router.put(
    '/:id/schedules',
    asyncHandler(async (req, res) => {
      const id = await scopedMedication(req);
      afterScope(req, canManageMedications, MANAGE_DENIED);

      const request = putMedicationSchedulesRequestSchema.parse(req.body);
      await putMedicationSchedules(db, keyRing, id, request, req.auditActor);
      const regenerated = await regenerateFutureDoses(db, id);

      // Lay the rest of the horizon now, so an admin who has just saved a
      // chart sees the week ahead rather than a screen that fills in an hour.
      const org = await getOrgSettings(db);
      const today = localDateOf(new Date(), org.timezone);
      await materialiseMedication(db, id, today, addDays(today, MEDICATION_HORIZON_DAYS));

      res.json({ medication: await getMedication(db, keyRing, id), regenerated });
    }),
  );

  return router;
}

/** Doses and sign-offs (doc 04 §10). */
export function doseRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  async function scopedDose(req: Request): Promise<string> {
    const principal = currentPrincipal(req);
    const { id } = idSchema.parse(req.params);
    const dose = await findDose(db, id);
    assertInScope(principal.scope, dose.participantId);
    return id;
  }

  router.put(
    '/:id/administration',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const id = await scopedDose(req);
      afterScope(req, canSignOffMedication, SIGN_OFF_DENIED);

      const request = signOffRequestSchema.parse(req.body);
      const { administration } = await signOffDose(
        db,
        keyRing,
        id,
        request,
        {
          userId: principal.user.id,
          role: principal.role,
          deviceId: req.auditActor.deviceId,
        },
        req.auditActor,
      );

      res.json({ administration });
    }),
  );

  return router;
}

/** A sign-off addressed by its own id, for adding a PRN outcome later. */
export function administrationRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const { id } = idSchema.parse(req.params);

      const existing = await getAdministration(db, keyRing, id);
      assertInScope(principal.scope, existing.participantId);
      afterScope(req, canSignOffMedication, SIGN_OFF_DENIED);

      const request = updateAdministrationRequestSchema.parse(req.body);
      const administration = await updateAdministrationOutcome(
        db,
        keyRing,
        id,
        request,
        {
          userId: principal.user.id,
          role: principal.role,
          deviceId: req.auditActor.deviceId,
        },
        req.auditActor,
      );

      res.json({ administration });
    }),
  );

  return router;
}

/**
 * The staff a sign-off can name as a witness.
 *
 * A worker needs this and cannot have the admin user list, so it is its own
 * endpoint returning the minimum: an id, a name and a role, for active staff
 * accounts only. No email, no status history, nothing about participants. It
 * is the staff directory colleagues already have in their heads.
 */
export function colleagueRoutes(db: Database): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/colleagues',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      if (!canSignOffMedication(principal.role)) {
        throw new HttpError('scope_denied', 'A self-access account has no colleagues to name.');
      }

      res.json({ colleagues: await listColleagues(db, principal.user.id) });
    }),
  );

  return router;
}

/** The Today feed's medication half, across everything the caller can see. */
export function myDoseRoutes(db: Database, keyRing: KeyRing): Router {
  const router = Router();

  router.use(requireAuth());

  router.get(
    '/medication-doses/due',
    asyncHandler(async (req, res) => {
      const principal = currentPrincipal(req);
      const within = z.coerce.number().int().min(0).max(10_080).optional().parse(req.query.within);
      const org = await getOrgSettings(db);

      const doses = await dueDoses(
        db,
        keyRing,
        principal.scope.kind === 'all' ? 'all' : principal.scope.participantIds,
        within === undefined ? {} : { withinMinutes: within },
      );

      res.json({ doses, timeZone: org.timezone });
    }),
  );

  return router;
}
