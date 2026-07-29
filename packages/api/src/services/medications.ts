import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  duplicateScheduleTimes,
  type CreateMedicationRequest,
  type Medication,
  type MedicationSchedule,
  type PutMedicationSchedulesRequest,
  type UpdateMedicationRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  medicationSchedules,
  medications,
  users,
  type MedicationRow,
  type MedicationScheduleRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptOptional, encryptOptional } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Medications and their due times (doc 01 §7.2, doc 04 §10).
 *
 * The definition only. Materialising doses, signing them off and recording a
 * PRN all live in `doses.ts`, which imports this one. The split is the same as
 * schedules and windows: what an admin configures is a different job from what
 * a worker does with it every day.
 *
 * Nothing here is ever deleted. A medication that has stopped is `active =
 * false` with an end date, which keeps the doses already signed off against it
 * readable, and keeps the record of what somebody was taking in March
 * truthful in June.
 */

export const INSTRUCTIONS_COLUMN = 'medications.instructions_enc';

/** Time-of-day columns come back as `HH:MM:SS`, and the wire wants `HH:MM`. */
function toTimeOfDay(value: string): string {
  return value.slice(0, 5);
}

function toSchedule(row: MedicationScheduleRow): MedicationSchedule {
  return {
    id: row.id,
    medicationId: row.medicationId,
    timeOfDay: toTimeOfDay(row.timeOfDay),
    weekdays: row.weekdays ?? null,
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
  };
}

export function toMedication(
  keyRing: KeyRing,
  row: MedicationRow,
  schedules: readonly MedicationScheduleRow[],
  createdByName: string | null,
): Medication {
  return {
    id: row.id,
    participantId: row.participantId,
    name: row.name,
    form: row.form,
    dose: row.dose,
    route: row.route,
    instructions: decryptOptional(keyRing, INSTRUCTIONS_COLUMN, row.instructionsEnc),
    isPrn: row.isPrn,
    startDate: row.startDate,
    endDate: row.endDate,
    requiresWitness: row.requiresWitness,
    active: row.active,
    schedules: schedules.map(toSchedule),
    createdBy: row.createdBy,
    createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Schedules for a set of medications, keyed by medication, in clock order. */
async function schedulesFor(
  db: Database,
  medicationIds: readonly string[],
): Promise<Map<string, MedicationScheduleRow[]>> {
  const byMedication = new Map<string, MedicationScheduleRow[]>();
  if (medicationIds.length === 0) return byMedication;

  const rows = await db
    .select()
    .from(medicationSchedules)
    .where(inArray(medicationSchedules.medicationId, [...medicationIds]))
    .orderBy(asc(medicationSchedules.timeOfDay));

  for (const row of rows) {
    const bucket = byMedication.get(row.medicationId) ?? [];
    bucket.push(row);
    byMedication.set(row.medicationId, bucket);
  }
  return byMedication;
}

async function toMedications(
  db: Database,
  keyRing: KeyRing,
  rows: readonly MedicationRow[],
): Promise<Medication[]> {
  if (rows.length === 0) return [];

  const schedules = await schedulesFor(
    db,
    rows.map((row) => row.id),
  );

  const authorIds = [...new Set(rows.map((row) => row.createdBy).filter((id) => id !== null))];
  const authors = new Map<string, string>();
  if (authorIds.length > 0) {
    const found = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, authorIds));
    for (const author of found) authors.set(author.id, author.displayName);
  }

  return rows.map((row) =>
    toMedication(
      keyRing,
      row,
      schedules.get(row.id) ?? [],
      row.createdBy === null ? null : (authors.get(row.createdBy) ?? null),
    ),
  );
}

export async function listMedications(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<Medication[]> {
  const filters = [eq(medications.participantId, participantId)];
  if (!options.includeInactive) filters.push(eq(medications.active, true));

  const rows = await db
    .select()
    .from(medications)
    .where(and(...filters))
    .orderBy(asc(medications.isPrn), asc(medications.name));

  return toMedications(db, keyRing, rows);
}

/** By id, for a sync page. Same DTO the screens render. */
export async function medicationsByIds(
  db: Database,
  keyRing: KeyRing,
  ids: readonly string[],
): Promise<Medication[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(medications)
    .where(inArray(medications.id, [...ids]));
  return toMedications(db, keyRing, rows);
}

export async function findMedicationRow(db: Database, id: string): Promise<MedicationRow> {
  const [row] = await db.select().from(medications).where(eq(medications.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That medication does not exist.');
  return row;
}

export async function getMedication(
  db: Database,
  keyRing: KeyRing,
  id: string,
): Promise<Medication> {
  const row = await findMedicationRow(db, id);
  const [medication] = await toMedications(db, keyRing, [row]);
  return medication!;
}

export async function createMedication(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateMedicationRequest,
  userId: string,
  actor: AuditActor,
): Promise<Medication> {
  const [row] = await db
    .insert(medications)
    .values({
      participantId,
      name: request.name,
      form: request.form,
      dose: request.dose,
      route: request.route,
      instructionsEnc: encryptOptional(keyRing, INSTRUCTIONS_COLUMN, request.instructions),
      isPrn: request.isPrn,
      startDate: request.startDate,
      endDate: request.endDate,
      requiresWitness: request.requiresWitness,
      createdBy: userId,
    })
    .returning();

  await recordAudit(db, {
    action: 'medication.create',
    actor,
    entityType: 'medication',
    entityId: row!.id,
    participantId,
    // The name and the dose, never the instructions: those are free text about
    // a person and belong in the encrypted column, not in the audit log.
    metadata: { name: request.name, dose: request.dose, isPrn: request.isPrn },
  });

  return getMedication(db, keyRing, row!.id);
}

/**
 * An edit.
 *
 * `isPrn` is deliberately not editable. Flipping a scheduled medication to PRN
 * would strand the doses already materialised against it, and flipping a PRN
 * one to scheduled would start generating doses for a medication whose whole
 * history is ad hoc. Stopping one and starting another says what actually
 * happened.
 */
export async function updateMedication(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: UpdateMedicationRequest,
  actor: AuditActor,
): Promise<Medication> {
  const existing = await findMedicationRow(db, id);

  const startDate = request.startDate ?? existing.startDate;
  const endDate = request.endDate === undefined ? existing.endDate : request.endDate;
  if (endDate !== null && endDate < startDate) {
    throw new HttpError('validation_failed', 'It ends before it starts.');
  }

  const patch: Partial<typeof medications.$inferInsert> = { updatedAt: new Date() };
  if (request.name !== undefined) patch.name = request.name;
  if (request.form !== undefined) patch.form = request.form;
  if (request.dose !== undefined) patch.dose = request.dose;
  if (request.route !== undefined) patch.route = request.route;
  if (request.instructions !== undefined) {
    patch.instructionsEnc = encryptOptional(keyRing, INSTRUCTIONS_COLUMN, request.instructions);
  }
  if (request.startDate !== undefined) patch.startDate = request.startDate;
  if (request.endDate !== undefined) patch.endDate = request.endDate;
  if (request.requiresWitness !== undefined) patch.requiresWitness = request.requiresWitness;
  if (request.active !== undefined) patch.active = request.active;

  await db.update(medications).set(patch).where(eq(medications.id, id));

  await recordAudit(db, {
    action: 'medication.update',
    actor,
    entityType: 'medication',
    entityId: id,
    participantId: existing.participantId,
    metadata: { fields: Object.keys(request).sort() },
  });

  return getMedication(db, keyRing, id);
}

/**
 * Replaces the whole set of due times.
 *
 * Whole-set rather than row by row, exactly as check segments are, so a clash
 * is checked against the end state instead of against whatever half-applied
 * shape a sequence of edits passes through.
 *
 * A PRN medication has no due times by definition, so this refuses rather than
 * quietly storing rows nothing will ever materialise.
 */
export async function putMedicationSchedules(
  db: Database,
  keyRing: KeyRing,
  medicationId: string,
  request: PutMedicationSchedulesRequest,
  actor: AuditActor,
): Promise<Medication> {
  const medication = await findMedicationRow(db, medicationId);

  if (medication.isPrn && request.schedules.length > 0) {
    throw new HttpError(
      'validation_failed',
      'A PRN medication is given as needed, so it has no scheduled times.',
    );
  }

  const clashes = duplicateScheduleTimes(request.schedules);
  if (clashes.length > 0) {
    throw new HttpError(
      'validation_failed',
      `${clashes.join(' and ')} is listed twice. Two doses at the same time means one gets signed off and the other is chased for ever.`,
    );
  }

  await db.transaction(async (tx) => {
    // A dose already materialised keeps its schedule_id set to null rather than
    // disappearing, so a dose signed off last week still exists after the chart
    // is edited today.
    await tx.delete(medicationSchedules).where(eq(medicationSchedules.medicationId, medicationId));

    if (request.schedules.length > 0) {
      await tx.insert(medicationSchedules).values(
        request.schedules.map((schedule) => ({
          medicationId,
          timeOfDay: schedule.timeOfDay,
          weekdays: schedule.weekdays,
          activeFrom: schedule.activeFrom,
          activeTo: schedule.activeTo,
        })),
      );
    }

    // Touching the parent is what tells a device the times changed. Schedules
    // travel inside the medication DTO rather than as their own sync entity,
    // exactly as check segments travel inside a schedule, so without this the
    // phone would keep yesterday's due times for ever.
    await tx
      .update(medications)
      .set({ updatedAt: new Date() })
      .where(eq(medications.id, medicationId));
  });

  await recordAudit(db, {
    action: 'medication.schedules_replaced',
    actor,
    entityType: 'medication',
    entityId: medicationId,
    participantId: medication.participantId,
    metadata: { times: request.schedules.map((schedule) => schedule.timeOfDay).sort() },
  });

  return getMedication(db, keyRing, medicationId);
}

/**
 * Active staff a sign-off can name as a witness (doc 01 §7.2).
 *
 * The caller is left out: naming yourself is refused at sign-off anyway, and
 * offering it in the list would only invite the tap that gets rejected.
 */
export async function listColleagues(
  db: Database,
  exceptUserId: string,
): Promise<{ id: string; displayName: string; role: string }[]> {
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, role: users.role })
    .from(users)
    .where(
      and(eq(users.status, 'active'), ne(users.role, 'participant'), ne(users.id, exceptUserId)),
    )
    .orderBy(asc(users.displayName));

  return rows;
}
