import {
  isEntryComplete,
  missingRequiredKeys,
  nextWindowStatus,
  templateSchemaSchema,
  type CheckValue,
  type CheckWindow,
  type MissedReasonCode,
  type ParticipantSummary,
  type PutEntryRequest,
  type PutMissReasonRequest,
  type TemplateSchema,
  type WindowDetail,
} from '@vigilo/shared';
import * as api from '@/api/client';
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

/** The schema a version carries, whichever side it came from. */
export function schemaOf(value: unknown): TemplateSchema {
  const parsed = templateSchemaSchema.safeParse(value);
  return parsed.success ? parsed.data : { fields: [] };
}
