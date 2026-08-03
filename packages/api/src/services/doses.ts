import { and, asc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  addDays,
  administrationProblem,
  backfillNeedsApproval,
  canBackfillPastCutoff,
  canEditOthersEntries,
  canWitnessMedication,
  describeCoverageDecision,
  doseCutoff,
  isLate,
  localDateOf,
  nextDoseStatus,
  parseTimeOfDay,
  resolveCoverage,
  weekdayOf,
  zonedTimeToUtc,
  MEDICATION_HORIZON_DAYS,
  type DoseStatus,
  type MedicationAdministration,
  type MedicationDose,
  type RecordPrnRequest,
  type Role,
  type SignOffRequest,
  type UpdateAdministrationRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  medicationAdministrations,
  medicationDoses,
  medicationSchedules,
  medications,
  participants,
  users,
  type MedicationAdministrationRow,
  type MedicationDoseRow,
  type MedicationRow,
  type MedicationScheduleRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptOptional, encryptOptional } from '../crypto/fields.js';
import { loadCoverage } from './coverage.js';
import { getOrgSettings } from './org.js';
import { recordDeletions } from './tombstones.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Doses and sign-offs (doc 01 §7.2, doc 03 §9).
 *
 * The medication counterpart of `windows.ts` and `entries.ts`, and deliberately
 * the same shape. Doses are materialised server-side on a fixed grid so a phone
 * with no signal knows what is due; coverage decides whether a dose was ours to
 * give; the sign-off is recorded against the dose with a device-generated id so
 * a replay updates rather than duplicates.
 *
 * The one thing a dose has that a window does not is a grace period. A window
 * has two ends and closes on its own; a dose is a single instant, so without a
 * grace period every dose would be missed the moment it fell due.
 */

export const NOTE_COLUMN = 'medication_administrations.note_enc';
export const REASON_COLUMN = 'medication_administrations.reason_enc';
export const OUTCOME_COLUMN = 'medication_administrations.outcome_enc';
export const DOSE_INSTRUCTIONS_COLUMN = 'medications.instructions_enc';

export type MedicationPrincipal = {
  userId: string;
  role: Role;
  deviceId: string | null;
};

/* --------------------------------------------------------- materialising */

function scheduleAppliesOn(schedule: MedicationScheduleRow, isoDate: string): boolean {
  if (schedule.activeFrom !== null && isoDate < schedule.activeFrom) return false;
  if (schedule.activeTo !== null && isoDate > schedule.activeTo) return false;
  if (schedule.weekdays === null) return true;
  return schedule.weekdays.includes(weekdayOf(isoDate));
}

function medicationAppliesOn(medication: MedicationRow, isoDate: string): boolean {
  if (isoDate < medication.startDate) return false;
  return medication.endDate === null || isoDate <= medication.endDate;
}

/**
 * Lays the due list for one medication across a range of local dates.
 *
 * Idempotent by `(medication, due_at)`, so the hourly job finds the dose it
 * already made rather than laying a second one beside it. Coverage is resolved
 * at insert over the span the dose could still be given in, which is the same
 * "expected if any part of it is covered" rule the check grid uses: a dose due
 * at 18:00 where support ends at 18:30 is a dose somebody was there to give.
 */
async function materialiseOne(
  db: Database,
  medication: MedicationRow,
  schedules: readonly MedicationScheduleRow[],
  fromDate: string,
  toDate: string,
  now = new Date(),
): Promise<number> {
  if (medication.isPrn || schedules.length === 0 || !medication.active) return 0;

  const coverage = await loadCoverage(db, medication.participantId);
  const org = await getOrgSettings(db);

  let created = 0;

  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    if (!medicationAppliesOn(medication, date)) continue;

    const rows = schedules
      .filter((schedule) => scheduleAppliesOn(schedule, date))
      .map((schedule) => {
        const dueAt = zonedTimeToUtc(
          date,
          parseTimeOfDay(schedule.timeOfDay.slice(0, 5)),
          coverage.timeZone,
        );
        const decision = resolveCoverage(
          { startsAt: dueAt, endsAt: doseCutoff(dueAt, org.medicationGraceMinutes) },
          coverage.ranges,
          coverage.exceptions,
          coverage.timeZone,
        );
        const status: DoseStatus = decision.expected ? 'pending' : 'not_required';

        return {
          medicationId: medication.id,
          participantId: medication.participantId,
          scheduleId: schedule.id,
          dueAt,
          expected: decision.expected,
          coverageReason: decision.expected ? null : describeCoverageDecision(decision),
          status,
        };
      })
      /*
       * Never a dose whose time has already passed.
       *
       * The materialiser lays whole local days, so a chart set up at 9am, or
       * a due time changed at 11pm, would otherwise produce a dose for 8am
       * that nobody could ever have given and that the closer marks missed
       * within five minutes. A missed dose says a person did not get their
       * medication, and inventing one for a time before the chart existed
       * blames staff for a dose nobody was ever asked for.
       *
       * Nothing is lost: doses are laid seven days ahead, so the only ones
       * this skips are the ones that were never really due.
       */
      .filter((row) => row.dueAt >= now);

    if (rows.length === 0) continue;

    const inserted = await db
      .insert(medicationDoses)
      .values(rows)
      .onConflictDoNothing({ target: [medicationDoses.medicationId, medicationDoses.dueAt] })
      .returning({ id: medicationDoses.id });

    created += inserted.length;
  }

  return created;
}

async function schedulesOf(db: Database, medicationId: string): Promise<MedicationScheduleRow[]> {
  return db
    .select()
    .from(medicationSchedules)
    .where(eq(medicationSchedules.medicationId, medicationId))
    .orderBy(asc(medicationSchedules.timeOfDay));
}

/** One medication's doses over a date range. Used after a schedule change. */
export async function materialiseMedication(
  db: Database,
  medicationId: string,
  fromDate: string,
  toDate: string,
): Promise<number> {
  const [medication] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, medicationId))
    .limit(1);
  if (!medication) return 0;

  return materialiseOne(db, medication, await schedulesOf(db, medicationId), fromDate, toDate);
}

/** Every active scheduled medication, over the rolling horizon. */
export async function materialiseDoseHorizon(
  db: Database,
  days = MEDICATION_HORIZON_DAYS,
): Promise<{ medications: number; created: number }> {
  const org = await getOrgSettings(db);
  const today = localDateOf(new Date(), org.timezone);
  const until = addDays(today, days);

  const rows = await db
    .select({ medication: medications })
    .from(medications)
    .innerJoin(participants, eq(participants.id, medications.participantId))
    .where(
      and(
        eq(medications.active, true),
        eq(medications.isPrn, false),
        eq(participants.status, 'active'),
      ),
    );

  let created = 0;
  for (const row of rows) {
    created += await materialiseOne(
      db,
      row.medication,
      await schedulesOf(db, row.medication.id),
      today,
      until,
    );
  }

  return { medications: rows.length, created };
}

/**
 * Rebuilds the remaining doses after the due times changed.
 *
 * A dose already signed off is never touched: the record of a medication that
 * reached a person does not move because somebody edited the chart afterwards.
 * Everything still ahead is removed with a tombstone, because a phone holding a
 * dose that no longer exists would let a worker sign off something the server
 * will refuse.
 */
export async function regenerateFutureDoses(
  db: Database,
  medicationId: string,
): Promise<{ removed: number; created: number }> {
  const now = new Date();

  const removed = await db
    .delete(medicationDoses)
    .where(
      and(
        eq(medicationDoses.medicationId, medicationId),
        gte(medicationDoses.dueAt, now),
        sql`not exists (select 1 from medication_administrations where medication_administrations.dose_id = ${medicationDoses.id})`,
      ),
    )
    .returning({ id: medicationDoses.id, participantId: medicationDoses.participantId });

  await recordDeletions(db, 'medication_dose', removed);

  const org = await getOrgSettings(db);
  const today = localDateOf(now, org.timezone);
  const created = await materialiseMedication(
    db,
    medicationId,
    today,
    addDays(today, MEDICATION_HORIZON_DAYS),
  );

  return { removed: removed.length, created };
}

/**
 * The closer. Moves doses past their grace period with no sign-off to `missed`,
 * which is what puts them at the top of the next worker's Today screen.
 *
 * `missed` is not the end: a dose signed off two hours late is still a dose
 * that was given, and it keeps its lateness for the record.
 */
export async function closeDoses(db: Database, now = new Date()): Promise<{ closed: number }> {
  const org = await getOrgSettings(db);
  const cutoff = new Date(now.getTime() - org.medicationGraceMinutes * 60_000);

  const due = await db
    .select({ id: medicationDoses.id })
    .from(medicationDoses)
    .where(
      and(
        eq(medicationDoses.status, 'pending'),
        lte(medicationDoses.dueAt, cutoff),
        sql`not exists (select 1 from medication_administrations where medication_administrations.dose_id = ${medicationDoses.id})`,
      ),
    )
    .limit(5000);

  if (due.length === 0) return { closed: 0 };

  await db
    .update(medicationDoses)
    .set({ status: 'missed', updatedAt: now })
    .where(
      inArray(
        medicationDoses.id,
        due.map((one) => one.id),
      ),
    );

  return { closed: due.length };
}

/** Recomputes one dose after something was recorded against it. */
async function recomputeDoseStatus(
  db: Database,
  doseId: string,
  now = new Date(),
): Promise<MedicationDoseRow> {
  const [dose] = await db
    .select()
    .from(medicationDoses)
    .where(eq(medicationDoses.id, doseId))
    .limit(1);
  if (!dose) throw new HttpError('not_found', 'That dose does not exist.');

  const [administration] = await db
    .select()
    .from(medicationAdministrations)
    .where(eq(medicationAdministrations.doseId, doseId))
    .limit(1);

  const org = await getOrgSettings(db);

  const status = nextDoseStatus({
    expected: dose.expected,
    administration: administration?.status ?? null,
    dueAt: dose.dueAt,
    graceMinutes: org.medicationGraceMinutes,
    now,
  });

  const [updated] = await db
    .update(medicationDoses)
    .set({ status, isLate: administration?.isLate ?? false, updatedAt: now })
    .where(eq(medicationDoses.id, doseId))
    .returning();

  return updated!;
}

/* ------------------------------------------------------------- reading */

type DoseBundle = {
  dose: MedicationDoseRow;
  medication: MedicationRow;
  administrationId: string | null;
};

async function loadDoseRows(db: Database, where: SQL): Promise<DoseBundle[]> {
  const rows = await db
    .select({
      dose: medicationDoses,
      medication: medications,
      administrationId: medicationAdministrations.id,
    })
    .from(medicationDoses)
    .innerJoin(medications, eq(medications.id, medicationDoses.medicationId))
    .leftJoin(medicationAdministrations, eq(medicationAdministrations.doseId, medicationDoses.id))
    .where(where)
    .orderBy(asc(medicationDoses.dueAt));

  return rows.map((row) => ({
    dose: row.dose,
    medication: row.medication,
    administrationId: row.administrationId,
  }));
}

function toDose(keyRing: KeyRing, bundle: DoseBundle): MedicationDose {
  return {
    id: bundle.dose.id,
    medicationId: bundle.dose.medicationId,
    participantId: bundle.dose.participantId,
    medicationName: bundle.medication.name,
    dose: bundle.medication.dose,
    form: bundle.medication.form,
    route: bundle.medication.route,
    instructions: decryptOptional(
      keyRing,
      DOSE_INSTRUCTIONS_COLUMN,
      bundle.medication.instructionsEnc,
    ),
    requiresWitness: bundle.medication.requiresWitness,
    dueAt: bundle.dose.dueAt.toISOString(),
    expected: bundle.dose.expected,
    coverageReason: bundle.dose.coverageReason,
    status: bundle.dose.status,
    isLate: bundle.dose.isLate,
    administrationId: bundle.administrationId,
  };
}

export async function listDoses(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: Date,
  to: Date,
): Promise<MedicationDose[]> {
  const bundles = await loadDoseRows(
    db,
    and(
      eq(medicationDoses.participantId, participantId),
      gte(medicationDoses.dueAt, from),
      lt(medicationDoses.dueAt, to),
    )!,
  );
  return bundles.map((bundle) => toDose(keyRing, bundle));
}

/** Doses by id, for a sync page. */
export async function dosesByIds(
  db: Database,
  keyRing: KeyRing,
  ids: readonly string[],
): Promise<MedicationDose[]> {
  if (ids.length === 0) return [];
  const bundles = await loadDoseRows(db, inArray(medicationDoses.id, [...ids]));
  return bundles.map((bundle) => toDose(keyRing, bundle));
}

/** Everything due across the caller's participants, which Today runs on. */
export async function dueDoses(
  db: Database,
  keyRing: KeyRing,
  participantIds: string[] | 'all',
  options: { withinMinutes?: number; lookBackHours?: number } = {},
): Promise<MedicationDose[]> {
  const now = new Date();
  const until = new Date(now.getTime() + (options.withinMinutes ?? 12 * 60) * 60_000);
  const since = new Date(now.getTime() - (options.lookBackHours ?? 48) * 3_600_000);

  const filters = [gte(medicationDoses.dueAt, since), lt(medicationDoses.dueAt, until)];
  if (participantIds !== 'all') {
    if (participantIds.length === 0) return [];
    filters.push(inArray(medicationDoses.participantId, participantIds));
  }

  const bundles = await loadDoseRows(db, and(...filters)!);
  return bundles.map((bundle) => toDose(keyRing, bundle));
}

export async function findDose(db: Database, id: string): Promise<MedicationDoseRow> {
  const [row] = await db.select().from(medicationDoses).where(eq(medicationDoses.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That dose does not exist.');
  return row;
}

/* ------------------------------------------------------ administrations */

type AdministrationBundle = {
  administration: MedicationAdministrationRow;
  medication: MedicationRow;
  recordedByName: string | null;
  witnessedByName: string | null;
};

function toAdministration(
  keyRing: KeyRing,
  bundle: AdministrationBundle,
): MedicationAdministration {
  const row = bundle.administration;
  return {
    id: row.id,
    doseId: row.doseId,
    medicationId: row.medicationId,
    participantId: row.participantId,
    medicationName: bundle.medication.name,
    dose: bundle.medication.dose,
    isPrn: bundle.medication.isPrn,
    status: row.status,
    administeredAt: row.administeredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    amountGiven: row.amountGiven,
    note: decryptOptional(keyRing, NOTE_COLUMN, row.noteEnc),
    reason: decryptOptional(keyRing, REASON_COLUMN, row.reasonEnc),
    outcome: decryptOptional(keyRing, OUTCOME_COLUMN, row.outcomeEnc),
    isLate: row.isLate,
    recordedBy: row.recordedBy,
    recordedByName: bundle.recordedByName,
    witnessedBy: row.witnessedBy,
    witnessedByName: bundle.witnessedByName,
  };
}

/** Two joins onto users, so the recorder and the witness both get a name. */
const witnesses = alias(users, 'witness');

async function loadAdministrations(db: Database, where: SQL): Promise<AdministrationBundle[]> {
  const rows = await db
    .select({
      administration: medicationAdministrations,
      medication: medications,
      recordedByName: users.displayName,
      witnessedByName: witnesses.displayName,
    })
    .from(medicationAdministrations)
    .innerJoin(medications, eq(medications.id, medicationAdministrations.medicationId))
    .leftJoin(users, eq(users.id, medicationAdministrations.recordedBy))
    .leftJoin(witnesses, eq(witnesses.id, medicationAdministrations.witnessedBy))
    .where(where)
    .orderBy(asc(medicationAdministrations.administeredAt));

  return rows.map((row) => ({
    administration: row.administration,
    medication: row.medication,
    recordedByName: row.recordedByName,
    witnessedByName: row.witnessedByName,
  }));
}

export async function administrationsByIds(
  db: Database,
  keyRing: KeyRing,
  ids: readonly string[],
): Promise<MedicationAdministration[]> {
  if (ids.length === 0) return [];
  const bundles = await loadAdministrations(db, inArray(medicationAdministrations.id, [...ids]));
  return bundles.map((bundle) => toAdministration(keyRing, bundle));
}

/** Everything signed off for a participant in a period, oldest first. */
export async function administrationsFor(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: Date,
  to: Date,
): Promise<MedicationAdministration[]> {
  const bundles = await loadAdministrations(
    db,
    and(
      eq(medicationAdministrations.participantId, participantId),
      gte(medicationAdministrations.administeredAt, from),
      lt(medicationAdministrations.administeredAt, to),
    )!,
  );
  return bundles.map((bundle) => toAdministration(keyRing, bundle));
}

export async function getAdministration(
  db: Database,
  keyRing: KeyRing,
  id: string,
): Promise<MedicationAdministration> {
  const [administration] = await administrationsByIds(db, keyRing, [id]);
  if (!administration) throw new HttpError('not_found', 'That sign-off does not exist.');
  return administration;
}

/* ------------------------------------------------------------- sign-off */

/**
 * The witness is named by the person signing off, not separately
 * authenticated.
 *
 * A paper chart works the same way: the second person's signature sits beside
 * the first. Vigilo checks that the named witness is a real, active staff
 * account and is not the person recording, which is what makes the name mean
 * anything. A true co-signature flow, where the witness authenticates on the
 * device, is a bigger change than this phase and is recorded as such (D60).
 */
async function assertWitness(db: Database, witnessedBy: string): Promise<void> {
  const [witness] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, witnessedBy))
    .limit(1);

  if (!witness || witness.status !== 'active' || !canWitnessMedication(witness.role)) {
    throw new HttpError('validation_failed', 'That witness is not an active staff account.');
  }
}

/**
 * The back-fill cut-off, the same rule and the same reasoning as a check entry
 * (doc 01 §5.5, A6). Past the cut-off a team leader or nurse is needed, because
 * that is the line between a late record and an invented one.
 *
 * `at` is the device's own recorded time for anything that came through the
 * outbox, so two days in a house with no signal does not turn into two days of
 * refused sign-offs (D46).
 */
async function assertBackfillAllowed(
  db: Database,
  deadline: Date,
  role: Role,
  at: Date,
): Promise<void> {
  const org = await getOrgSettings(db);
  if (!backfillNeedsApproval(deadline, at, org.lateEntryCutoffMinutes)) return;
  if (canBackfillPastCutoff(role)) return;

  const hours = Math.round(org.lateEntryCutoffMinutes / 60);
  throw new HttpError(
    'conflict',
    `This dose was due more than ${hours} hours ago. A team leader or nurse can still record it.`,
  );
}

export type SignOffOptions = {
  /** True when this arrived through the outbox rather than from a screen. */
  recordedOffline?: boolean;
};

/**
 * Signs off one scheduled dose.
 *
 * Idempotent by the device-generated id, so a replayed operation updates the
 * same row rather than writing a second sign-off for the same dose. A different
 * id against a dose somebody else has already answered is a conflict, not an
 * overwrite: two people signing off the same dose is a thing to resolve, not to
 * silently pick a winner for.
 */
export async function signOffDose(
  db: Database,
  keyRing: KeyRing,
  doseId: string,
  request: SignOffRequest,
  principal: MedicationPrincipal,
  actor: AuditActor,
  options: SignOffOptions = {},
): Promise<{ administration: MedicationAdministration; dose: MedicationDoseRow }> {
  const now = new Date();

  const dose = await findDose(db, doseId);
  const [medication] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, dose.medicationId))
    .limit(1);
  if (!medication) throw new HttpError('not_found', 'That medication does not exist.');

  const problem = administrationProblem({
    status: request.status,
    note: request.note,
    amountGiven: request.amountGiven,
    witnessedBy: request.witnessedBy,
    requiresWitness: medication.requiresWitness,
    recordedBy: principal.userId,
  });
  if (problem !== null) throw new HttpError('validation_failed', problem);

  if (request.witnessedBy !== null) await assertWitness(db, request.witnessedBy);

  const [existing] = await db
    .select()
    .from(medicationAdministrations)
    .where(eq(medicationAdministrations.doseId, doseId))
    .limit(1);

  if (existing && existing.id !== request.id) {
    throw new HttpError(
      'conflict',
      'Someone else has already signed off this dose. Open it again to see what they recorded.',
    );
  }

  const org = await getOrgSettings(db);
  const deadline = doseCutoff(dose.dueAt, org.medicationGraceMinutes);

  if (!existing) {
    const backfillAt = options.recordedOffline ? new Date(request.recordedAt) : now;
    await assertBackfillAllowed(db, deadline, principal.role, backfillAt);
  }

  const late = isLate(deadline, now);
  const noteEnc = encryptOptional(keyRing, NOTE_COLUMN, request.note);

  await db
    .insert(medicationAdministrations)
    .values({
      id: request.id,
      doseId,
      medicationId: dose.medicationId,
      participantId: dose.participantId,
      status: request.status,
      administeredAt: new Date(request.administeredAt),
      recordedAt: new Date(request.recordedAt),
      receivedAt: now,
      amountGiven: request.amountGiven,
      noteEnc,
      isLate: late,
      recordedBy: principal.userId,
      witnessedBy: request.witnessedBy,
      deviceId: principal.deviceId,
    })
    // Replaying the same operation updates rather than duplicates, which is
    // what makes the offline outbox safe to retry (doc 04 §1).
    .onConflictDoUpdate({
      target: medicationAdministrations.id,
      set: {
        status: request.status,
        administeredAt: new Date(request.administeredAt),
        recordedAt: new Date(request.recordedAt),
        amountGiven: request.amountGiven,
        noteEnc,
        witnessedBy: request.witnessedBy,
        updatedAt: now,
      },
    });

  const updated = await recomputeDoseStatus(db, doseId, now);

  await recordAudit(db, {
    action: existing ? 'medication.sign_off_update' : 'medication.sign_off',
    actor,
    entityType: 'medication_administration',
    entityId: request.id,
    participantId: dose.participantId,
    // The status and whether it was witnessed, never the note: a note is free
    // text about a person.
    metadata: {
      medicationId: dose.medicationId,
      status: request.status,
      isLate: late,
      witnessed: request.witnessedBy !== null,
    },
  });

  return { administration: await getAdministration(db, keyRing, request.id), dose: updated };
}

/**
 * A PRN dose, recorded ad hoc.
 *
 * There is no dose row to answer, because a medication given as needed has no
 * due time to materialise. The reason is required and the outcome is not
 * (doc 01 §7.2): why it was given is known at the moment it is given, and what
 * it did is often not known for another hour.
 */
export async function recordPrn(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: RecordPrnRequest,
  principal: MedicationPrincipal,
  actor: AuditActor,
  options: SignOffOptions = {},
): Promise<MedicationAdministration> {
  const now = new Date();

  const [medication] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, request.medicationId))
    .limit(1);
  if (!medication || medication.participantId !== participantId) {
    throw new HttpError('not_found', 'That medication does not exist for this participant.');
  }
  if (!medication.isPrn) {
    throw new HttpError(
      'validation_failed',
      'That medication is scheduled, so sign it off against its due dose rather than as a PRN.',
    );
  }
  if (!medication.active) {
    throw new HttpError('validation_failed', 'That medication has been stopped.');
  }

  const problem = administrationProblem({
    status: request.status,
    note: request.note,
    amountGiven: request.amountGiven,
    witnessedBy: request.witnessedBy,
    requiresWitness: medication.requiresWitness,
    recordedBy: principal.userId,
  });
  if (problem !== null) throw new HttpError('validation_failed', problem);

  if (request.witnessedBy !== null) await assertWitness(db, request.witnessedBy);

  const [existing] = await db
    .select()
    .from(medicationAdministrations)
    .where(eq(medicationAdministrations.id, request.id))
    .limit(1);

  if (!existing) {
    const administeredAt = new Date(request.administeredAt);
    const backfillAt = options.recordedOffline ? new Date(request.recordedAt) : now;
    await assertBackfillAllowed(db, administeredAt, principal.role, backfillAt);
  }

  const noteEnc = encryptOptional(keyRing, NOTE_COLUMN, request.note);
  const reasonEnc = encryptOptional(keyRing, REASON_COLUMN, request.reason);
  const outcomeEnc = encryptOptional(keyRing, OUTCOME_COLUMN, request.outcome);

  await db
    .insert(medicationAdministrations)
    .values({
      id: request.id,
      doseId: null,
      medicationId: medication.id,
      participantId,
      status: request.status,
      administeredAt: new Date(request.administeredAt),
      recordedAt: new Date(request.recordedAt),
      receivedAt: now,
      amountGiven: request.amountGiven,
      noteEnc,
      reasonEnc,
      outcomeEnc,
      // A PRN dose answers no due time, so there is nothing for it to be late
      // for. Recording it as late would invent a schedule it never had.
      isLate: false,
      recordedBy: principal.userId,
      witnessedBy: request.witnessedBy,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: medicationAdministrations.id,
      set: {
        status: request.status,
        administeredAt: new Date(request.administeredAt),
        recordedAt: new Date(request.recordedAt),
        amountGiven: request.amountGiven,
        noteEnc,
        reasonEnc,
        outcomeEnc,
        witnessedBy: request.witnessedBy,
        updatedAt: now,
      },
    });

  await recordAudit(db, {
    action: existing ? 'medication.prn_update' : 'medication.prn',
    actor,
    entityType: 'medication_administration',
    entityId: request.id,
    participantId,
    metadata: {
      medicationId: medication.id,
      status: request.status,
      witnessed: request.witnessedBy !== null,
    },
  });

  return getAdministration(db, keyRing, request.id);
}

/**
 * Adds the outcome to a PRN dose once it is known.
 *
 * The only field on a sign-off that can change afterwards. Everything else is
 * a statement about what happened at a moment that has passed, and a record
 * that can be rewritten is not a record.
 */
export async function updateAdministrationOutcome(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: UpdateAdministrationRequest,
  principal: MedicationPrincipal,
  actor: AuditActor,
): Promise<MedicationAdministration> {
  const [row] = await db
    .select()
    .from(medicationAdministrations)
    .where(eq(medicationAdministrations.id, id))
    .limit(1);
  if (!row) throw new HttpError('not_found', 'That sign-off does not exist.');

  if (row.doseId !== null) {
    throw new HttpError(
      'validation_failed',
      'An outcome belongs to a PRN dose, which is the one given for a reason.',
    );
  }

  // The same rule as editing somebody else's check entry: your own record is
  // yours to complete, and changing another person's needs oversight.
  if (row.recordedBy !== principal.userId && !canEditOthersEntries(principal.role)) {
    throw new HttpError(
      'scope_denied',
      "Only a team leader, nurse or admin can add an outcome to someone else's record.",
    );
  }

  await db
    .update(medicationAdministrations)
    .set({
      outcomeEnc: encryptOptional(keyRing, OUTCOME_COLUMN, request.outcome),
      updatedAt: new Date(),
    })
    .where(eq(medicationAdministrations.id, id));

  await recordAudit(db, {
    action: 'medication.outcome',
    actor,
    entityType: 'medication_administration',
    entityId: id,
    participantId: row.participantId,
    metadata: { hasOutcome: (request.outcome ?? '').trim() !== '' },
  });

  return getAdministration(db, keyRing, id);
}

/** Doses still open right now, so a worker is told what they are walking into. */
export async function openDoseCount(db: Database, participantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(medicationDoses)
    .where(
      and(
        eq(medicationDoses.participantId, participantId),
        inArray(medicationDoses.status, ['pending', 'missed']),
        gt(medicationDoses.dueAt, new Date(Date.now() - 48 * 3_600_000)),
      ),
    );
  return Number(row?.count ?? 0);
}
