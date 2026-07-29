import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  addDays,
  csvRow,
  formatFieldValue,
  orderedFields,
  zonedTimeToUtc,
  type ExportJob,
  type ExportKind,
  type ExportQuery,
  type Scope,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  checkEntries,
  checkEntryValues,
  checkTemplateVersions,
  checkWindows,
  diaryCategories,
  diaryEntries,
  exportJobs,
  medicationAdministrations,
  medicationDoses,
  medications,
  participants,
  users,
  type ExportJobRow,
} from '../db/schema.js';
import { decryptField, decryptOptional, encryptField } from '../crypto/fields.js';
import { HttpError } from '../middleware/errors.js';
import { getOrgSettings } from './org.js';
import { COLUMN } from './participants.js';
import { BODY_COLUMN } from './diary.js';
import { VALUE_TEXT_COLUMN } from './windows.js';
import { NOTE_COLUMN, OUTCOME_COLUMN, REASON_COLUMN } from './doses.js';
import { parseSchema } from './templates.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { FileStore } from './storage.js';

/**
 * CSV export (doc 01 §8.4, doc 07 §5).
 *
 * Raw records for a date range, one row per record, with a column per field
 * key for checks. Every export is audit-logged with its filters and its row
 * count, because this is the one feature that takes participant data out of
 * the system entirely, and "who exported what" is the question that gets asked
 * afterwards.
 *
 * Below `EXPORT_INLINE_ROW_LIMIT` it streams straight back. Above it, the
 * request returns a job and the file is built in the background.
 */

export type ExportPrincipal = {
  userId: string;
  scope: Scope;
};

function scopeIds(scope: Scope, requested?: string): string[] | 'all' {
  if (requested !== undefined) {
    if (scope.kind === 'ids' && !scope.participantIds.includes(requested)) {
      throw new HttpError('scope_denied', 'You are not assigned to this participant.');
    }
    return [requested];
  }
  return scope.kind === 'all' ? 'all' : scope.participantIds;
}

/* ------------------------------------------------------------- the rows */

/**
 * How many rows an export would produce.
 *
 * Counted before anything is built, so the decision between streaming and
 * queueing is made on the real number rather than on a guess from the date
 * range. A month for one participant and a month for forty are very different
 * files.
 */
export async function countRows(
  db: Database,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<number> {
  const org = await getOrgSettings(db);
  const ids = scopeIds(principal.scope, query.participantId);
  if (ids !== 'all' && ids.length === 0) return 0;

  const from = zonedTimeToUtc(query.from, 0, org.timezone);
  const to = zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone);

  if (query.kind === 'checks') {
    const filters = [gte(checkEntries.recordedAt, from), lt(checkEntries.recordedAt, to)];
    if (ids !== 'all') filters.push(inArray(checkEntries.participantId, ids));
    const [row] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(checkEntries)
      .where(and(...filters));
    return Number(row?.count ?? 0);
  }

  if (query.kind === 'medications') {
    const filters = [
      gte(medicationAdministrations.administeredAt, from),
      lt(medicationAdministrations.administeredAt, to),
    ];
    if (ids !== 'all') filters.push(inArray(medicationAdministrations.participantId, ids));
    const [row] = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(medicationAdministrations)
      .where(and(...filters));
    return Number(row?.count ?? 0);
  }

  const filters = [gte(diaryEntries.occurredAt, from), lt(diaryEntries.occurredAt, to)];
  if (ids !== 'all') filters.push(inArray(diaryEntries.participantId, ids));
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(diaryEntries)
    .where(and(...filters));
  return Number(row?.count ?? 0);
}

/**
 * The whole file, as a string.
 *
 * Held in memory rather than streamed. An export past the threshold is a job
 * with its own memory budget, and one below it is at most a few thousand rows,
 * so the streaming machinery would buy complexity rather than headroom.
 */
export async function buildCsv(
  db: Database,
  keyRing: KeyRing,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  if (query.kind === 'checks') return checksCsv(db, keyRing, principal, query);
  if (query.kind === 'medications') return medicationsCsv(db, keyRing, principal, query);
  return diaryCsv(db, keyRing, principal, query);
}

/**
 * One row per sign-off, scheduled and PRN together (doc 04 §11).
 *
 * A sign-off is the record, so this exports administrations rather than doses.
 * A dose nobody answered has no row here on purpose: "what was given" and
 * "what was missed" are different questions, and the second one is what the
 * compliance report and the daily report are for.
 */
async function medicationsCsv(
  db: Database,
  keyRing: KeyRing,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  const org = await getOrgSettings(db);
  const ids = scopeIds(principal.scope, query.participantId);
  if (ids !== 'all' && ids.length === 0) return { csv: '', rowCount: 0 };

  const from = zonedTimeToUtc(query.from, 0, org.timezone);
  const to = zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone);

  const filters = [
    gte(medicationAdministrations.administeredAt, from),
    lt(medicationAdministrations.administeredAt, to),
  ];
  if (ids !== 'all') filters.push(inArray(medicationAdministrations.participantId, ids));

  const witnesses = alias(users, 'witness');

  const rows = await db
    .select({
      administration: medicationAdministrations,
      medication: medications,
      dueAt: medicationDoses.dueAt,
      recordedByName: users.displayName,
      witnessedByName: witnesses.displayName,
      firstNameEnc: participants.firstNameEnc,
      lastNameEnc: participants.lastNameEnc,
    })
    .from(medicationAdministrations)
    .innerJoin(medications, eq(medications.id, medicationAdministrations.medicationId))
    .innerJoin(participants, eq(participants.id, medicationAdministrations.participantId))
    .leftJoin(medicationDoses, eq(medicationDoses.id, medicationAdministrations.doseId))
    .leftJoin(users, eq(users.id, medicationAdministrations.recordedBy))
    .leftJoin(witnesses, eq(witnesses.id, medicationAdministrations.witnessedBy))
    .where(and(...filters))
    .orderBy(asc(medicationAdministrations.administeredAt));

  let csv = csvRow([
    'administration_id',
    'participant',
    'medication',
    'form',
    'dose',
    'route',
    'is_prn',
    'due_at',
    'administered_at',
    'recorded_at',
    'received_at',
    'status',
    'is_late',
    'recorded_by',
    'witnessed_by',
    'reason',
    'outcome',
    'note',
  ]);

  for (const row of rows) {
    csv += csvRow([
      row.administration.id,
      `${decryptField(keyRing, COLUMN.firstName, row.firstNameEnc)} ${decryptField(keyRing, COLUMN.lastName, row.lastNameEnc)}`,
      row.medication.name,
      row.medication.form,
      row.medication.dose,
      row.medication.route,
      row.medication.isPrn,
      row.dueAt?.toISOString() ?? null,
      row.administration.administeredAt.toISOString(),
      row.administration.recordedAt.toISOString(),
      row.administration.receivedAt.toISOString(),
      row.administration.status,
      row.administration.isLate,
      row.recordedByName,
      row.witnessedByName,
      decryptOptional(keyRing, REASON_COLUMN, row.administration.reasonEnc),
      decryptOptional(keyRing, OUTCOME_COLUMN, row.administration.outcomeEnc),
      decryptOptional(keyRing, NOTE_COLUMN, row.administration.noteEnc),
    ]);
  }

  return { csv, rowCount: rows.length };
}

/**
 * One row per check entry, one column per field key.
 *
 * The column set is the union of every field key in range, so an export that
 * crosses a template version change keeps both the old columns and the new
 * ones rather than dropping whichever came second.
 */
async function checksCsv(
  db: Database,
  keyRing: KeyRing,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  const org = await getOrgSettings(db);
  const ids = scopeIds(principal.scope, query.participantId);
  if (ids !== 'all' && ids.length === 0) return { csv: '', rowCount: 0 };

  const from = zonedTimeToUtc(query.from, 0, org.timezone);
  const to = zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone);

  const filters = [gte(checkEntries.recordedAt, from), lt(checkEntries.recordedAt, to)];
  if (ids !== 'all') filters.push(inArray(checkEntries.participantId, ids));

  const rows = await db
    .select({
      entry: checkEntries,
      window: checkWindows,
      recordedByName: users.displayName,
      firstNameEnc: participants.firstNameEnc,
      lastNameEnc: participants.lastNameEnc,
    })
    .from(checkEntries)
    .innerJoin(checkWindows, eq(checkWindows.id, checkEntries.windowId))
    .innerJoin(participants, eq(participants.id, checkEntries.participantId))
    .leftJoin(users, eq(users.id, checkEntries.recordedBy))
    .where(and(...filters))
    .orderBy(asc(checkEntries.recordedAt));

  if (rows.length === 0) return { csv: '', rowCount: 0 };

  const entryIds = rows.map((row) => row.entry.id);
  const values = await db
    .select()
    .from(checkEntryValues)
    .where(inArray(checkEntryValues.entryId, entryIds));

  const versionIds = [...new Set(rows.map((row) => row.entry.templateVersionId))];
  const versions = await db
    .select()
    .from(checkTemplateVersions)
    .where(inArray(checkTemplateVersions.id, versionIds));

  const fieldsByVersion = new Map(
    versions.map((version) => [version.id, orderedFields(parseSchema(version))] as const),
  );

  // Every field key seen, in the order the forms present them, so the columns
  // read the way the workers filled them in.
  const columns: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const versionId of versionIds) {
    for (const field of fieldsByVersion.get(versionId) ?? []) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      columns.push({ key: field.key, label: field.label });
    }
  }

  const byEntry = new Map<string, typeof values>();
  for (const value of values) {
    const bucket = byEntry.get(value.entryId) ?? [];
    bucket.push(value);
    byEntry.set(value.entryId, bucket);
  }

  let csv = csvRow([
    'entry_id',
    'participant',
    'window_start',
    'window_end',
    'window_status',
    'recorded_at',
    'received_at',
    'recorded_by',
    'is_late',
    'late_by_minutes',
    'entry_status',
    'edit_count',
    ...columns.map((column) => column.label),
  ]);

  for (const row of rows) {
    const fields = fieldsByVersion.get(row.entry.templateVersionId) ?? [];
    const recorded = byEntry.get(row.entry.id) ?? [];

    const cells = columns.map((column) => {
      const value = recorded.find((one) => one.fieldKey === column.key);
      if (!value) return '';
      return formatFieldValue(
        fields.find((field) => field.key === column.key),
        {
          number: value.valueNumber === null ? null : Number(value.valueNumber),
          bool: value.valueBool,
          text: decryptOptional(keyRing, VALUE_TEXT_COLUMN, value.valueTextEnc),
          json: (value.valueJson ?? null) as string | string[] | null,
          unit: value.unit,
        },
      );
    });

    csv += csvRow([
      row.entry.id,
      `${decryptField(keyRing, COLUMN.firstName, row.firstNameEnc)} ${decryptField(keyRing, COLUMN.lastName, row.lastNameEnc)}`,
      row.window.startsAt.toISOString(),
      row.window.endsAt.toISOString(),
      row.window.status,
      row.entry.recordedAt.toISOString(),
      row.entry.receivedAt.toISOString(),
      row.recordedByName,
      row.entry.isLate,
      row.window.lateByMinutes,
      row.entry.status,
      row.entry.editCount,
      ...cells,
    ]);
  }

  return { csv, rowCount: rows.length };
}

async function diaryCsv(
  db: Database,
  keyRing: KeyRing,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  const org = await getOrgSettings(db);
  const ids = scopeIds(principal.scope, query.participantId);
  if (ids !== 'all' && ids.length === 0) return { csv: '', rowCount: 0 };

  const from = zonedTimeToUtc(query.from, 0, org.timezone);
  const to = zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone);

  const filters = [gte(diaryEntries.occurredAt, from), lt(diaryEntries.occurredAt, to)];
  if (ids !== 'all') filters.push(inArray(diaryEntries.participantId, ids));

  const rows = await db
    .select({
      entry: diaryEntries,
      categoryLabel: diaryCategories.label,
      recordedByName: users.displayName,
      firstNameEnc: participants.firstNameEnc,
      lastNameEnc: participants.lastNameEnc,
    })
    .from(diaryEntries)
    .innerJoin(diaryCategories, eq(diaryCategories.id, diaryEntries.categoryId))
    .innerJoin(participants, eq(participants.id, diaryEntries.participantId))
    .leftJoin(users, eq(users.id, diaryEntries.recordedBy))
    .where(and(...filters))
    .orderBy(asc(diaryEntries.occurredAt));

  let csv = csvRow([
    'entry_id',
    'participant',
    'occurred_at',
    'recorded_at',
    'category',
    'body',
    'recorded_by',
    'visible_to_participant',
    'edit_count',
    'deleted_at',
  ]);

  for (const row of rows) {
    csv += csvRow([
      row.entry.id,
      `${decryptField(keyRing, COLUMN.firstName, row.firstNameEnc)} ${decryptField(keyRing, COLUMN.lastName, row.lastNameEnc)}`,
      row.entry.occurredAt.toISOString(),
      row.entry.recordedAt.toISOString(),
      row.categoryLabel,
      decryptField(keyRing, BODY_COLUMN, row.entry.bodyEnc),
      row.recordedByName,
      row.entry.visibleToParticipant,
      row.entry.editCount,
      row.entry.deletedAt?.toISOString() ?? null,
    ]);
  }

  return { csv, rowCount: rows.length };
}

/* ------------------------------------------------------------- the audit */

/**
 * Every export, logged with what it covered and how much came out.
 *
 * Doc 07 §5 names exports specifically. The filters and the row count are the
 * point: "an admin exported something" is not an answer, "this admin exported
 * 4,200 check entries for these dates" is.
 */
export async function auditExport(
  db: Database,
  actor: AuditActor,
  query: ExportQuery,
  rowCount: number,
  delivery: 'inline' | 'job',
): Promise<void> {
  await recordAudit(db, {
    action: 'export.create',
    actor,
    entityType: 'export',
    participantId: query.participantId ?? null,
    metadata: {
      kind: query.kind,
      from: query.from,
      to: query.to,
      participantId: query.participantId ?? 'all in scope',
      rowCount,
      delivery,
    },
  });
}

/* --------------------------------------------------------------- the jobs */

/** How long a built export stays on disk before it is deleted. */
export const EXPORT_TTL_HOURS = 24;

/** Its own data key, wrapped by the master key, like an attachment's. */
const KEY_COLUMN = 'export_jobs.data_key_enc';

export function toExportJob(row: ExportJobRow): ExportJob {
  return {
    id: row.id,
    kind: row.kind as ExportKind,
    from: row.fromDate,
    to: row.toDate,
    status: row.status as ExportJob['status'],
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    error: row.error,
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function queueExport(
  db: Database,
  principal: ExportPrincipal,
  query: ExportQuery,
): Promise<ExportJob> {
  const [row] = await db
    .insert(exportJobs)
    .values({
      userId: principal.userId,
      kind: query.kind,
      fromDate: query.from,
      toDate: query.to,
      participantId: query.participantId ?? null,
      status: 'queued',
      expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
    })
    .returning();

  return toExportJob(row!);
}

export async function listExports(db: Database, userId: string): Promise<ExportJob[]> {
  const rows = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.userId, userId))
    .orderBy(sql`${exportJobs.requestedAt} desc`)
    .limit(20);
  return rows.map(toExportJob);
}

export async function findExport(db: Database, id: string, userId: string): Promise<ExportJobRow> {
  const [row] = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.id, id), eq(exportJobs.userId, userId)))
    .limit(1);
  // Somebody else's export is not found rather than forbidden: the id is not
  // theirs to know about either way.
  if (!row) throw new HttpError('not_found', 'That export does not exist.');
  return row;
}

/**
 * Builds one queued export.
 *
 * Run by the job runner, one at a time. The scope is the requester's, resolved
 * again here rather than stored on the row: an export queued before somebody
 * lost access to a participant must not be built with the access they had.
 */
export async function runExport(
  db: Database,
  keyRing: KeyRing,
  store: FileStore,
  row: ExportJobRow,
  scope: Scope,
): Promise<void> {
  await db.update(exportJobs).set({ status: 'running' }).where(eq(exportJobs.id, row.id));

  try {
    const { csv, rowCount } = await buildCsv(
      db,
      keyRing,
      { userId: row.userId, scope },
      {
        kind: row.kind as ExportKind,
        from: row.fromDate,
        to: row.toDate,
        ...(row.participantId === null ? {} : { participantId: row.participantId }),
      },
    );

    const stored = await store.put(Buffer.from(csv, 'utf8'), 'csv');

    await db
      .update(exportJobs)
      .set({
        status: 'ready',
        rowCount,
        byteSize: stored.byteSize,
        storagePath: stored.path,
        dataKeyEnc: encryptField(keyRing, KEY_COLUMN, stored.key.toString('base64')),
        finishedAt: new Date(),
      })
      .where(eq(exportJobs.id, row.id));
  } catch (error) {
    await db
      .update(exportJobs)
      .set({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(exportJobs.id, row.id));
  }
}

export async function claimQueuedExports(db: Database, limit = 3): Promise<ExportJobRow[]> {
  return db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.status, 'queued'))
    .orderBy(asc(exportJobs.requestedAt))
    .limit(limit);
}

/**
 * Deletes expired exports, file and row.
 *
 * A built CSV is decrypted participant data sitting on a volume. Keeping it
 * around because somebody might download it again is the wrong trade: they can
 * ask for it again, and until they do it should not exist.
 */
export async function pruneExports(
  db: Database,
  store: FileStore,
  now = new Date(),
): Promise<number> {
  const rows = await db.select().from(exportJobs).where(lte(exportJobs.expiresAt, now));

  for (const row of rows) {
    if (row.storagePath !== null) await store.remove(row.storagePath).catch(() => undefined);
  }

  if (rows.length > 0) {
    await db.delete(exportJobs).where(
      inArray(
        exportJobs.id,
        rows.map((row) => row.id),
      ),
    );
  }

  return rows.length;
}

/** The stored file's key, unwrapped. */
export function exportDataKey(keyRing: KeyRing, row: ExportJobRow): Buffer {
  if (row.dataKeyEnc === null || row.storagePath === null) {
    throw new HttpError('not_found', 'That export has not been built yet.');
  }
  return Buffer.from(decryptField(keyRing, KEY_COLUMN, row.dataKeyEnc), 'base64');
}
