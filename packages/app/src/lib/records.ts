import {
  isEntryComplete,
  missingRequiredKeys,
  nextWindowStatus,
  templateSchemaSchema,
  type CheckValue,
  type CarePlan,
  type CheckWindow,
  type MarkCarePlanReadRequest,
  type Medication,
  type MedicationAdministration,
  type MedicationDose,
  type EmergencyContact,
  type EmergencyPlan,
  type MissedReasonCode,
  type ParticipantAlert,
  type ParticipantDetail,
  type ParticipantSummary,
  type PutEntryRequest,
  type PutMissReasonRequest,
  type RecordPrnRequest,
  type SignOffRequest,
  type TemplateSchema,
  type WindowDetail,
} from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useOfflineStore } from '@/stores/offline';
import { useSessionStore } from '@/stores/session';
import { uuidv7 } from '@/lib/uuid';

/**
 * Where a screen gets its records, and where a save goes.
 *
 * Local first whenever the device has an unlocked database, because that is
 * what makes the app work in a house with no signal. Straight to the API
 * otherwise, which is the admin at a desk in a browser tab.
 *
 * Screens call this rather than the API client directly, so neither of them
 * has to know which of the two it got.
 */

export type Source = 'local' | 'server';

function store() {
  return useOfflineStore();
}

function local() {
  const offline = store();
  return offline.state === 'ready' ? offline.localStore : null;
}

/* ------------------------------------------------------------------ reading */

export async function readToday(): Promise<{
  windows: CheckWindow[];
  participants: ParticipantSummary[];
  timeZone: string;
  source: Source;
}> {
  const db = local();

  if (db) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return {
      // The same span the server's Today feed covers: yesterday's misses still
      // need a reason, and the rest of today is what a worker is walking into.
      windows: await db.windowsBetween<CheckWindow>(
        new Date(now - 2 * day).toISOString(),
        new Date(now + day).toISOString(),
      ),
      participants: await db.participants<ParticipantSummary>(),
      // The org timezone travels with the session, not with the records: it is
      // one setting for the whole organisation and it is what every timestamp
      // is shown in (doc 06 §7).
      timeZone: useSessionStore().org?.timezone ?? 'Australia/Melbourne',
      source: 'local',
    };
  }

  const [due, participants] = await Promise.all([api.listDueWindows(), api.listParticipants()]);
  return { windows: due.windows, participants, timeZone: due.timeZone, source: 'server' };
}

export async function readReasonCodes(): Promise<MissedReasonCode[]> {
  const db = local();
  return db ? db.reasonCodes<MissedReasonCode>() : api.listReasonCodes();
}

/**
 * A window with everything the form needs.
 *
 * Assembled locally from three tables rather than fetched, because a worker
 * standing in a bedroom with no signal has to be able to open the form and
 * type into it. The pieces are all already on the device: the window, the
 * template version it is bound to, and any entry recorded against it.
 */
export async function readWindow(windowId: string): Promise<WindowDetail | null> {
  const db = local();
  if (!db) return api.getWindow(windowId);

  const window = await db.window<CheckWindow>(windowId);
  if (!window) return api.getWindow(windowId);

  const version = await db.templateVersion<{ schema: unknown }>(window.templateVersionId);
  const entry = await db.entryForWindow<{ id: string; status: string; values: CheckValue[] }>(
    windowId,
  );

  return {
    ...window,
    templateSchema: version?.schema ?? { fields: [] },
    entryStatus: (entry?.status as 'partial' | 'complete' | undefined) ?? null,
    entry: entry ?? null,
    /*
     * Always false offline.
     *
     * The back-fill cut-off is the server's decision and it is made from the
     * time the worker recorded, not the time we managed to send (D46). A
     * device that refused the form here would stop a worker recording care
     * they are standing in front of, on a rule the server is going to apply
     * generously anyway.
     */
    backfillNeedsApproval: false,
  };
}

/* ------------------------------------------------------------------ writing */

/**
 * Records a check.
 *
 * Through the outbox whenever the device has a local database, and straight to
 * the API otherwise. The outbox path writes the entry locally in the same
 * breath, so the screen updates instantly rather than waiting for a network
 * round trip that may never come (doc 05 §5).
 */
export async function recordEntry(input: {
  window: WindowDetail;
  entryId: string;
  values: CheckValue[];
}): Promise<{ detail: WindowDetail; queued: boolean }> {
  const request: PutEntryRequest = {
    entryId: input.entryId,
    templateVersionId: input.window.templateVersionId,
    recordedAt: new Date().toISOString(),
    values: input.values,
  };

  const db = local();
  if (!db) {
    return { detail: await api.putEntry(input.window.id, request), queued: false };
  }

  const schema = schemaOf(input.window.templateSchema);
  const complete = isEntryComplete(schema, input.values);
  const remaining = missingRequiredKeys(schema, input.values).length;
  const filled = Math.max(0, input.window.requiredFieldCount - remaining);

  /*
   * The status comes from the shared state machine, not from anything invented
   * here. The server derives it from the same function on the same inputs, so
   * what the worker sees the instant they save is what the record will say
   * once it arrives (CLAUDE.md: if the two can disagree, it is a bug).
   */
  const status = nextWindowStatus({
    expected: input.window.expected,
    hasEntry: true,
    entryComplete: complete,
    endsAt: new Date(input.window.endsAt),
    now: new Date(),
  });

  await db.recordEntryLocally({
    entry: {
      id: input.entryId,
      windowId: input.window.id,
      participantId: input.window.participantId,
      recordedAt: request.recordedAt,
    },
    status: complete ? 'complete' : 'partial',
    filledRequiredCount: filled,
    sealedEntry: {
      id: input.entryId,
      windowId: input.window.id,
      participantId: input.window.participantId,
      templateVersionId: input.window.templateVersionId,
      recordedBy: null,
      recordedByName: null,
      recordedAt: request.recordedAt,
      receivedAt: request.recordedAt,
      status: complete ? 'complete' : 'partial',
      isLate: false,
      editedAt: null,
      editCount: 0,
      values: input.values,
    },
    windowStatus: status,
  });

  await store().enqueue({
    opId: uuidv7(),
    kind: 'check_entry.put',
    participantId: input.window.participantId,
    windowId: input.window.id,
    payload: request,
  });

  return {
    detail: {
      ...input.window,
      status,
      entryId: input.entryId,
      entryStatus: complete ? 'complete' : 'partial',
      filledRequiredCount: filled,
      entry: { id: input.entryId, values: input.values },
    },
    queued: true,
  };
}

export async function recordMissReason(input: {
  window: WindowDetail;
  request: PutMissReasonRequest;
}): Promise<{ detail: WindowDetail; queued: boolean }> {
  const db = local();
  if (!db) {
    return { detail: await api.putMissReason(input.window.id, input.request), queued: false };
  }

  await store().enqueue({
    opId: uuidv7(),
    kind: 'miss_reason.put',
    participantId: input.window.participantId,
    windowId: input.window.id,
    payload: { ...input.request, id: uuidv7() },
  });

  return { detail: input.window, queued: true };
}

/* ------------------------------------------------------------ participants */

export async function readParticipants(): Promise<ParticipantSummary[]> {
  const db = local();
  return db ? db.participants<ParticipantSummary>() : api.listParticipants();
}

/**
 * One participant, with everything the screen can show.
 *
 * Local first, because the emergency panel is the one thing doc 01 §7.4 says
 * must never need a network, and because a care plan a worker cannot reach is
 * not a care plan they can read (doc 01 §11). The device holds the summary, the
 * alerts, the contacts and the emergency plan, so all of that renders offline.
 *
 * What it does not hold is the administrative detail: date of birth, NDIS
 * number, address. Those are never synced, so `partial` says so and the screen
 * says so rather than showing convincing blanks.
 */
export async function readParticipant(
  id: string,
): Promise<{ participant: ParticipantDetail; partial: boolean }> {
  const db = local();
  if (!db) return { participant: await api.getParticipant(id), partial: false };

  try {
    return { participant: await api.getParticipant(id), partial: false };
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;

    const summary = await db.participant<ParticipantSummary>(id);
    if (summary === null) throw error;

    return {
      participant: {
        ...summary,
        dateOfBirth: '',
        ndisNumber: '',
        address: null,
        phone: null,
        email: null,
        notes: null,
        createdAt: '',
        updatedAt: '',
        alerts: await db.alertsFor<ParticipantAlert>(id),
        contacts: await db.contactsFor<EmergencyContact>(id),
        emergencyPlan: await db.emergencyPlanFor<EmergencyPlan>(id),
      },
      partial: true,
    };
  }
}

/* -------------------------------------------------------------- care plans */

/**
 * The plans for a participant.
 *
 * Local first, because doc 01 §11 lists reading a care plan as something that
 * must work with no connection: the instructions for the person in front of you
 * are the last thing that should need signal.
 */
export async function readCarePlans(participantId: string): Promise<CarePlan[]> {
  const db = local();
  return db ? db.carePlansFor<CarePlan>(participantId) : api.listCarePlans(participantId);
}

export async function readCarePlan(id: string): Promise<CarePlan | null> {
  const db = local();
  if (!db) return api.getCarePlan(id);
  return (await db.carePlan<CarePlan>(id)) ?? api.getCarePlan(id);
}

/**
 * Records that this worker has read the current version.
 *
 * The marker clears on the device straight away and the receipt goes up through
 * the outbox, so a plan read in a house with no signal does not keep nagging
 * until the phone finds a tower.
 */
export async function markCarePlanRead(plan: CarePlan): Promise<{ queued: boolean }> {
  const request: MarkCarePlanReadRequest = {
    id: uuidv7(),
    readAt: new Date().toISOString(),
  };

  const db = local();
  if (!db) {
    await api.markCarePlanRead(plan.id, request);
    return { queued: false };
  }

  await db.markCarePlanReadLocally(plan.id, { ...plan, unread: false });
  await store().enqueue({
    opId: uuidv7(),
    kind: 'care_plan.read',
    participantId: plan.participantId,
    carePlanId: plan.id,
    payload: request,
  });

  return { queued: true };
}

/* -------------------------------------------------------------- medications */

/**
 * The doses a worker is walking into.
 *
 * Local first, like every other record read here. Signing off a dose is the
 * other thing that has to work in a house with no signal, and the doses were
 * materialised on the server days ago precisely so the phone already holds
 * them.
 */
export async function readDueDoses(): Promise<{ doses: MedicationDose[]; source: Source }> {
  const db = local();

  if (db) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return {
      doses: await db.dosesBetween<MedicationDose>(
        new Date(now - 2 * day).toISOString(),
        new Date(now + day).toISOString(),
      ),
      source: 'local',
    };
  }

  return { doses: (await api.listDueDoses()).doses, source: 'server' };
}

/**
 * The staff a witness can be picked from.
 *
 * Refreshed whenever there is a connection and cached sealed on the device, so
 * a worker signing off a witnessed medication in a house with no signal still
 * gets a list rather than an empty picker and a dose they cannot record.
 */
export async function readColleagues(): Promise<api.Colleague[]> {
  const db = local();
  if (!db) return api.listColleagues();

  try {
    const colleagues = await api.listColleagues();
    await db.setColleagues(colleagues);
    return colleagues;
  } catch {
    return db.colleagues<api.Colleague>();
  }
}

export async function readDose(doseId: string): Promise<MedicationDose | null> {
  const db = local();
  if (!db) return null;
  return db.dose<MedicationDose>(doseId);
}

export async function readMedications(participantId: string): Promise<Medication[]> {
  const db = local();
  return db ? db.medicationsFor<Medication>(participantId) : api.listMedications(participantId);
}

export async function readAdministrations(
  participantId: string,
): Promise<MedicationAdministration[]> {
  const db = local();
  return db
    ? db.administrationsFor<MedicationAdministration>(participantId)
    : api.listAdministrations(participantId);
}

/**
 * Signs off a dose.
 *
 * Through the outbox when the device has a local database, straight to the API
 * otherwise. The rules that decide whether the sign-off is allowed at all, a
 * note on a refusal and a witness where the medication needs one, are checked
 * by the caller against the shared function, so a worker with no signal is
 * told at the moment they tap rather than two hours later.
 */
export async function signOffDose(input: {
  dose: MedicationDose;
  request: SignOffRequest;
}): Promise<{ dose: MedicationDose; queued: boolean }> {
  const db = local();

  if (!db) {
    await api.signOffDose(input.dose.id, input.request);
    return { dose: { ...input.dose, status: input.request.status }, queued: false };
  }

  const updated: MedicationDose = {
    ...input.dose,
    status: input.request.status,
    administrationId: input.request.id,
  };

  await db.recordSignOffLocally({
    administration: {
      id: input.request.id,
      participantId: input.dose.participantId,
      medicationId: input.dose.medicationId,
      doseId: input.dose.id,
      administeredAt: input.request.administeredAt,
    },
    doseStatus: input.request.status,
    sealedAdministration: {
      id: input.request.id,
      doseId: input.dose.id,
      medicationId: input.dose.medicationId,
      participantId: input.dose.participantId,
      medicationName: input.dose.medicationName,
      dose: input.dose.dose,
      isPrn: false,
      status: input.request.status,
      administeredAt: input.request.administeredAt,
      recordedAt: input.request.recordedAt,
      receivedAt: input.request.recordedAt,
      note: input.request.note,
      reason: null,
      outcome: null,
      // Lateness comes from the server clock, always. Claiming it here would
      // be the device deciding something it is not allowed to decide.
      isLate: input.dose.isLate,
      recordedBy: null,
      recordedByName: null,
      witnessedBy: input.request.witnessedBy,
      witnessedByName: null,
    },
    sealedDose: updated,
  });

  await store().enqueue({
    opId: uuidv7(),
    kind: 'medication.sign_off',
    participantId: input.dose.participantId,
    doseId: input.dose.id,
    payload: input.request,
  });

  return { dose: updated, queued: true };
}

/** A PRN dose, which answers no scheduled time and so updates no dose row. */
export async function recordPrn(input: {
  participantId: string;
  medication: Medication;
  request: RecordPrnRequest;
}): Promise<{ queued: boolean }> {
  const db = local();

  if (!db) {
    await api.recordPrn(input.participantId, input.request);
    return { queued: false };
  }

  await db.recordSignOffLocally({
    administration: {
      id: input.request.id,
      participantId: input.participantId,
      medicationId: input.medication.id,
      doseId: null,
      administeredAt: input.request.administeredAt,
    },
    doseStatus: null,
    sealedAdministration: {
      id: input.request.id,
      doseId: null,
      medicationId: input.medication.id,
      participantId: input.participantId,
      medicationName: input.medication.name,
      dose: input.medication.dose,
      isPrn: true,
      status: input.request.status,
      administeredAt: input.request.administeredAt,
      recordedAt: input.request.recordedAt,
      receivedAt: input.request.recordedAt,
      note: input.request.note,
      reason: input.request.reason,
      outcome: input.request.outcome,
      isLate: false,
      recordedBy: null,
      recordedByName: null,
      witnessedBy: input.request.witnessedBy,
      witnessedByName: null,
    },
    sealedDose: null,
  });

  await store().enqueue({
    opId: uuidv7(),
    kind: 'medication.prn',
    participantId: input.participantId,
    payload: input.request,
  });

  return { queued: true };
}

/** The schema a version carries, whichever side it came from. */
export function schemaOf(value: unknown): TemplateSchema {
  const parsed = templateSchemaSchema.safeParse(value);
  return parsed.success ? parsed.data : { fields: [] };
}
