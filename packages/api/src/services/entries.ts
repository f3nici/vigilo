import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  backfillNeedsApproval,
  canBackfillPastCutoff,
  canEditOthersEntries,
  isEntryComplete,
  isLate,
  lateByMinutes,
  missReasonProblem,
  validateValues,
  type CheckEntry,
  type CheckValue,
  type EditEntryRequest,
  type EntryRevision,
  type MissReason,
  type PutEntryRequest,
  type PutMissReasonRequest,
  type Role,
  type TemplateSchema,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  checkEntries,
  checkEntryRevisions,
  checkEntryValues,
  checkTemplateVersions,
  checkWindows,
  missedReasonCodes,
  users,
  windowMissReasons,
  type CheckEntryRow,
  type CheckEntryValueRow,
  type CheckWindowRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, decryptOptional, encryptField, encryptOptional } from '../crypto/fields.js';
import { parseSchema } from './templates.js';
import {
  MISS_NOTE_COLUMN,
  VALUE_TEXT_COLUMN,
  recomputeWindowStatus,
  toCheckValue,
} from './windows.js';
import { getOrgSettings } from './org.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Recording a check (doc 01 §5.5, doc 04 §7).
 *
 * Three rules shape everything here:
 *
 * - **Partial is normal.** The same row is updated as more fields are filled,
 *   never a second one, so a worker who fills two fields now and three later
 *   produces one record of one check.
 * - **Late is accepted, not refused.** A check that happened is worth more than
 *   a tidy compliance number, so back-fill is recorded and flagged rather than
 *   blocked, up to the cut-off where it needs a team leader.
 * - **Nothing is overwritten silently.** Every edit writes a revision row with
 *   the old and the new value. The current value displays, the history is one
 *   tap away, and neither can be removed.
 */

const REVISION_COLUMN = 'check_entry_revisions.values_enc';

export type EntryPrincipal = {
  userId: string;
  role: Role;
  deviceId: string | null;
};

/** What a value row looks like on the wire, for the revision history. */
type StoredValue = {
  number: number | null;
  bool: boolean | null;
  text: string | null;
  json: string | string[] | null;
};

function storedValueOf(keyRing: KeyRing, row: CheckEntryValueRow): StoredValue {
  return {
    number: row.valueNumber === null ? null : Number(row.valueNumber),
    bool: row.valueBool,
    text: decryptOptional(keyRing, VALUE_TEXT_COLUMN, row.valueTextEnc),
    json: (row.valueJson ?? null) as string | string[] | null,
  };
}

function requestedValueOf(value: CheckValue): StoredValue {
  return {
    number: value.number ?? null,
    bool: value.bool ?? null,
    text: value.text ?? null,
    json: value.json ?? null,
  };
}

function sameValue(a: StoredValue, b: StoredValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadSchema(db: Database, versionId: string): Promise<TemplateSchema> {
  const [version] = await db
    .select()
    .from(checkTemplateVersions)
    .where(eq(checkTemplateVersions.id, versionId))
    .limit(1);
  if (!version) throw new HttpError('not_found', 'That version of the check form does not exist.');
  return parseSchema(version);
}

function unitFor(schema: TemplateSchema, fieldKey: string): string | null {
  const field = schema.fields.find((one) => one.key === fieldKey);
  return field?.type === 'number' ? field.unit : null;
}

/** The columns a value lands in, decided by the field's own type. */
function valueColumns(
  keyRing: KeyRing,
  schema: TemplateSchema,
  value: CheckValue,
): Pick<
  typeof checkEntryValues.$inferInsert,
  'valueNumber' | 'valueBool' | 'valueTextEnc' | 'valueJson' | 'unit'
> {
  return {
    // numeric is stored as a string so Postgres keeps it exact.
    valueNumber: value.number === null || value.number === undefined ? null : String(value.number),
    valueBool: value.bool ?? null,
    valueTextEnc:
      value.text === null || value.text === undefined
        ? null
        : encryptField(keyRing, VALUE_TEXT_COLUMN, value.text),
    valueJson: value.json ?? null,
    unit: unitFor(schema, value.fieldKey),
  };
}

async function currentValues(db: Database, entryId: string): Promise<CheckEntryValueRow[]> {
  return db
    .select()
    .from(checkEntryValues)
    .where(eq(checkEntryValues.entryId, entryId))
    .orderBy(asc(checkEntryValues.fieldKey));
}

async function toEntry(db: Database, keyRing: KeyRing, row: CheckEntryRow): Promise<CheckEntry> {
  const values = await currentValues(db, row.id);
  const [recorder] = row.recordedBy
    ? await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, row.recordedBy))
        .limit(1)
    : [];

  return {
    id: row.id,
    windowId: row.windowId,
    participantId: row.participantId,
    templateVersionId: row.templateVersionId,
    recordedBy: row.recordedBy,
    recordedByName: recorder?.displayName ?? null,
    recordedAt: row.recordedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    status: row.status,
    isLate: row.isLate,
    editedAt: row.editedAt?.toISOString() ?? null,
    editCount: row.editCount,
    values: values.map((value) => toCheckValue(keyRing, value)),
  };
}

async function assertBackfillAllowed(
  db: Database,
  window: CheckWindowRow,
  principal: EntryPrincipal,
  now: Date,
): Promise<void> {
  const org = await getOrgSettings(db);
  if (!backfillNeedsApproval(window.endsAt, now, org.lateEntryCutoffMinutes)) return;
  if (canBackfillPastCutoff(principal.role)) return;

  const hours = Math.round(org.lateEntryCutoffMinutes / 60);
  throw new HttpError(
    'conflict',
    `This window closed more than ${hours} hours ago. A team leader or nurse can still record it.`,
  );
}

/**
 * Upsert by client-supplied id (doc 04 §7).
 *
 * Only the supplied fields are written: an absent field is left alone, and a
 * field sent as null is cleared. Those are different requests and mean
 * different things, which is why the wire schema distinguishes them.
 *
 * A submission against a superseded version is refused with
 * `template_version_mismatch` rather than remapped. The device keeps its data,
 * downloads the new version and asks the worker to confirm. Silently remapping
 * a clinical value onto a field that changed under it is the one outcome nobody
 * would ever want.
 */
export async function putEntry(
  db: Database,
  keyRing: KeyRing,
  windowId: string,
  request: PutEntryRequest,
  principal: EntryPrincipal,
  actor: AuditActor,
): Promise<{ entry: CheckEntry; window: CheckWindowRow }> {
  const now = new Date();

  const [window] = await db
    .select()
    .from(checkWindows)
    .where(eq(checkWindows.id, windowId))
    .limit(1);
  if (!window) throw new HttpError('not_found', 'That check window does not exist.');

  if (request.templateVersionId !== window.templateVersionId) {
    throw new HttpError(
      'template_version_mismatch',
      'This check form has changed since you started. Open it again to check your answers before saving.',
      { expected: window.templateVersionId },
    );
  }

  const schema = await loadSchema(db, window.templateVersionId);
  const problems = validateValues(schema, request.values);
  if (problems.length > 0) {
    throw new HttpError('validation_failed', problems[0]!.message, { problems });
  }

  const [existing] = await db
    .select()
    .from(checkEntries)
    .where(eq(checkEntries.windowId, windowId))
    .limit(1);

  if (existing && existing.id !== request.entryId) {
    throw new HttpError(
      'conflict',
      'Someone else has already recorded this check. Open it again to see what they entered.',
    );
  }

  if (!existing) await assertBackfillAllowed(db, window, principal, now);

  const late = isLate(window.endsAt, now);

  const entry = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(checkEntries)
      .values({
        id: request.entryId,
        windowId,
        participantId: window.participantId,
        templateVersionId: window.templateVersionId,
        recordedBy: principal.userId,
        recordedAt: new Date(request.recordedAt),
        receivedAt: now,
        status: 'partial',
        isLate: late,
        deviceId: principal.deviceId,
      })
      // Replaying the same request must update rather than duplicate, which is
      // what makes the offline outbox safe to retry (doc 04 §1).
      .onConflictDoUpdate({
        target: checkEntries.id,
        set: { recordedAt: new Date(request.recordedAt), updatedAt: now },
      })
      .returning();

    for (const value of request.values) {
      const columns = valueColumns(keyRing, schema, value);
      await tx
        .insert(checkEntryValues)
        .values({
          entryId: row!.id,
          fieldKey: value.fieldKey,
          ...columns,
          recordedAt: value.recordedAt ? new Date(value.recordedAt) : now,
          recordedBy: principal.userId,
        })
        .onConflictDoUpdate({
          target: [checkEntryValues.entryId, checkEntryValues.fieldKey],
          set: {
            ...columns,
            recordedAt: value.recordedAt ? new Date(value.recordedAt) : now,
            recordedBy: principal.userId,
            updatedAt: now,
          },
        });
    }

    const stored = await tx
      .select()
      .from(checkEntryValues)
      .where(eq(checkEntryValues.entryId, row!.id));

    const asValues: CheckValue[] = stored.map((value) => ({
      fieldKey: value.fieldKey,
      number: value.valueNumber === null ? null : Number(value.valueNumber),
      bool: value.valueBool,
      // Presence is what completeness needs; the plaintext is not read here.
      text: value.valueTextEnc === null ? null : 'set',
      json: (value.valueJson ?? null) as string | string[] | null,
    }));

    const [updated] = await tx
      .update(checkEntries)
      .set({
        status: isEntryComplete(schema, asValues) ? 'complete' : 'partial',
        updatedAt: now,
      })
      .where(eq(checkEntries.id, row!.id))
      .returning();

    return updated!;
  });

  const updatedWindow = await recomputeWindowStatus(db, windowId, now);

  await recordAudit(db, {
    action: existing ? 'check_entry.update' : 'check_entry.create',
    actor,
    entityType: 'check_entry',
    entityId: entry.id,
    participantId: window.participantId,
    // Which fields were written and whether it was late. Never the values.
    metadata: {
      fields: request.values.map((value) => value.fieldKey).sort(),
      status: entry.status,
      isLate: late,
      lateByMinutes: late ? lateByMinutes(window.endsAt, now) : 0,
    },
  });

  return { entry: await toEntry(db, keyRing, entry), window: updatedWindow };
}

/**
 * An edit after submission (doc 01 §5.5).
 *
 * The original is preserved. Every changed field writes a revision row holding
 * the old and the new value, encrypted as a pair so the history cannot become a
 * way to read what the entry itself keeps encrypted.
 */
export async function editEntry(
  db: Database,
  keyRing: KeyRing,
  entryId: string,
  request: EditEntryRequest,
  principal: EntryPrincipal,
  actor: AuditActor,
): Promise<{ entry: CheckEntry; window: CheckWindowRow }> {
  const now = new Date();

  const [entry] = await db.select().from(checkEntries).where(eq(checkEntries.id, entryId)).limit(1);
  if (!entry) throw new HttpError('not_found', 'That check entry does not exist.');

  if (entry.recordedBy !== principal.userId && !canEditOthersEntries(principal.role)) {
    throw new HttpError(
      'scope_denied',
      "Only a team leader, nurse or admin can change someone else's entry.",
    );
  }

  const schema = await loadSchema(db, entry.templateVersionId);
  const problems = validateValues(schema, request.values);
  if (problems.length > 0) {
    throw new HttpError('validation_failed', problems[0]!.message, { problems });
  }

  const before = await currentValues(db, entryId);
  const beforeByKey = new Map(before.map((value) => [value.fieldKey, value]));

  const changedKeys: string[] = [];

  await db.transaction(async (tx) => {
    for (const value of request.values) {
      const old = beforeByKey.get(value.fieldKey);
      const oldValue: StoredValue = old
        ? storedValueOf(keyRing, old)
        : { number: null, bool: null, text: null, json: null };
      const newValue = requestedValueOf(value);

      if (sameValue(oldValue, newValue)) continue;
      changedKeys.push(value.fieldKey);

      const columns = valueColumns(keyRing, schema, value);
      await tx
        .insert(checkEntryValues)
        .values({
          entryId,
          fieldKey: value.fieldKey,
          ...columns,
          recordedAt: now,
          recordedBy: principal.userId,
        })
        .onConflictDoUpdate({
          target: [checkEntryValues.entryId, checkEntryValues.fieldKey],
          set: { ...columns, recordedAt: now, recordedBy: principal.userId, updatedAt: now },
        });

      await tx.insert(checkEntryRevisions).values({
        entryId,
        fieldKey: value.fieldKey,
        valuesEnc: encryptField(
          keyRing,
          REVISION_COLUMN,
          JSON.stringify({ old: oldValue, new: newValue }),
        ),
        changedBy: principal.userId,
        changedAt: now,
        reason: request.reason ?? null,
      });
    }

    if (changedKeys.length === 0) return;

    const stored = await tx
      .select()
      .from(checkEntryValues)
      .where(eq(checkEntryValues.entryId, entryId));

    const asValues: CheckValue[] = stored.map((value) => ({
      fieldKey: value.fieldKey,
      number: value.valueNumber === null ? null : Number(value.valueNumber),
      bool: value.valueBool,
      text: value.valueTextEnc === null ? null : 'set',
      json: (value.valueJson ?? null) as string | string[] | null,
    }));

    await tx
      .update(checkEntries)
      .set({
        status: isEntryComplete(schema, asValues) ? 'complete' : 'partial',
        editedAt: now,
        editCount: entry.editCount + 1,
        updatedAt: now,
      })
      .where(eq(checkEntries.id, entryId));
  });

  const window = await recomputeWindowStatus(db, entry.windowId, now);

  if (changedKeys.length > 0) {
    await recordAudit(db, {
      action: 'check_entry.edit',
      actor,
      entityType: 'check_entry',
      entityId: entryId,
      participantId: entry.participantId,
      metadata: {
        fields: [...changedKeys].sort(),
        editedAnothersEntry: entry.recordedBy !== principal.userId,
      },
    });
  }

  const [updated] = await db
    .select()
    .from(checkEntries)
    .where(eq(checkEntries.id, entryId))
    .limit(1);

  return { entry: await toEntry(db, keyRing, updated!), window };
}

/** The edit history, oldest first. Append-only, so this is the whole story. */
export async function listRevisions(
  db: Database,
  keyRing: KeyRing,
  entryId: string,
): Promise<EntryRevision[]> {
  const rows = await db
    .select({ revision: checkEntryRevisions, changedByName: users.displayName })
    .from(checkEntryRevisions)
    .leftJoin(users, eq(users.id, checkEntryRevisions.changedBy))
    .where(eq(checkEntryRevisions.entryId, entryId))
    .orderBy(asc(checkEntryRevisions.changedAt));

  return rows.map(({ revision, changedByName }) => {
    const pair = JSON.parse(decryptField(keyRing, REVISION_COLUMN, revision.valuesEnc)) as {
      old: unknown;
      new: unknown;
    };
    return {
      id: revision.id,
      fieldKey: revision.fieldKey,
      oldValue: pair.old ?? null,
      newValue: pair.new ?? null,
      changedBy: revision.changedBy,
      changedByName,
      changedAt: revision.changedAt.toISOString(),
      reason: revision.reason,
    };
  });
}

export async function getEntry(db: Database, entryId: string): Promise<CheckEntryRow> {
  const [row] = await db.select().from(checkEntries).where(eq(checkEntries.id, entryId)).limit(1);
  if (!row) throw new HttpError('not_found', 'That check entry does not exist.');
  return row;
}

/**
 * The miss reason (doc 01 §5.6). Mandatory on a missed window, and surfaced at
 * the top of the participant screen until it is given.
 */
export async function putMissReason(
  db: Database,
  keyRing: KeyRing,
  windowId: string,
  request: PutMissReasonRequest,
  principal: EntryPrincipal,
  actor: AuditActor,
): Promise<MissReason> {
  const now = new Date();

  const [window] = await db
    .select()
    .from(checkWindows)
    .where(eq(checkWindows.id, windowId))
    .limit(1);
  if (!window) throw new HttpError('not_found', 'That check window does not exist.');

  const [code] = await db
    .select()
    .from(missedReasonCodes)
    .where(and(eq(missedReasonCodes.id, request.reasonCodeId), eq(missedReasonCodes.active, true)))
    .limit(1);
  if (!code) throw new HttpError('validation_failed', 'That reason is not one of the options.');

  const problem = missReasonProblem(code, request.note ?? null);
  if (problem !== null) throw new HttpError('validation_failed', problem);

  const [existing] = await db
    .select()
    .from(windowMissReasons)
    .where(eq(windowMissReasons.windowId, windowId))
    .limit(1);

  const id = existing?.id ?? request.id ?? randomUUID();
  const noteEnc = encryptOptional(keyRing, MISS_NOTE_COLUMN, request.note ?? null);

  const [row] = await db
    .insert(windowMissReasons)
    .values({
      id,
      windowId,
      reasonCodeId: request.reasonCodeId,
      noteEnc,
      recordedBy: principal.userId,
      recordedAt: request.recordedAt ? new Date(request.recordedAt) : now,
      receivedAt: now,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: windowMissReasons.windowId,
      set: {
        reasonCodeId: request.reasonCodeId,
        noteEnc,
        recordedBy: principal.userId,
        recordedAt: request.recordedAt ? new Date(request.recordedAt) : now,
        updatedAt: now,
      },
    })
    .returning();

  await recordAudit(db, {
    action: existing ? 'window.miss_reason_update' : 'window.miss_reason',
    actor,
    entityType: 'check_window',
    entityId: windowId,
    participantId: window.participantId,
    // The code, never the note: a note is free text about a person.
    metadata: { code: code.code, hasNote: (request.note ?? '').trim() !== '' },
  });

  const [recorder] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);

  return {
    id: row!.id,
    windowId,
    reasonCodeId: code.id,
    code: code.code,
    label: code.label,
    note: decryptOptional(keyRing, MISS_NOTE_COLUMN, row!.noteEnc),
    recordedBy: row!.recordedBy,
    recordedByName: recorder?.displayName ?? null,
    recordedAt: row!.recordedAt.toISOString(),
  };
}

/** Windows the caller still owes a reason for, which Today pins to the top. */
export async function unresolvedMissedWindows(
  db: Database,
  participantIds: string[] | 'all',
): Promise<number> {
  const filters = [eq(checkWindows.status, 'missed'), isNull(windowMissReasons.id)];
  if (participantIds !== 'all') {
    if (participantIds.length === 0) return 0;
    filters.push(inArray(checkWindows.participantId, participantIds));
  }

  const rows = await db
    .select({ id: checkWindows.id })
    .from(checkWindows)
    .leftJoin(windowMissReasons, eq(windowMissReasons.windowId, checkWindows.id))
    .where(and(...filters));

  return rows.length;
}
