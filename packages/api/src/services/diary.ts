import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import {
  addDays,
  buildTimeline,
  canReadDiaryEntry,
  matchesDiarySearch,
  occurredAtProblem,
  zonedTimeToUtc,
  type AttachmentSummary,
  type CreateDiaryCategoryRequest,
  type CreateDiaryEntryRequest,
  type DiaryCategory,
  type DiaryEntry,
  type DiaryQuery,
  type DiaryRevision,
  type Role,
  type TimelineItem,
  type UpdateDiaryCategoryRequest,
  type UpdateDiaryEntryRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  diaryCategories,
  diaryEntries,
  diaryEntryRevisions,
  users,
  type DiaryCategoryRow,
  type DiaryEntryRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, encryptField } from '../crypto/fields.js';
import { attachmentsForOwners, claimAttachments } from './attachments.js';
import { listWindows } from './windows.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * The diary (doc 01 §6, doc 03 §7, doc 04 §8).
 *
 * Bodies are encrypted, which decides more than it looks like it does. It is
 * why search happens here on decrypted text rather than in Postgres (A9), and
 * why the edit history stores its old and new values as an encrypted pair
 * rather than as plain columns.
 */

const BODY_COLUMN = 'diary_entries.body_enc';
const REVISION_COLUMN = 'diary_entry_revisions.values_enc';

export type DiaryPrincipal = {
  userId: string;
  role: Role;
  deviceId: string | null;
  /** The participant this account *is*, when the caller is a self-access one. */
  ownParticipantId: string | null;
};

/** What a viewer is allowed to see, in the terms the shared rule is written in. */
function viewerOf(principal: DiaryPrincipal, participantId: string) {
  return {
    isParticipantSelf:
      principal.role === 'participant' && principal.ownParticipantId === participantId,
    isAdmin: principal.role === 'admin',
  };
}

export function toDiaryCategory(row: DiaryCategoryRow): DiaryCategory {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    colour: row.colour,
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

export async function listCategories(
  db: Database,
  options: { includeInactive?: boolean } = {},
): Promise<DiaryCategory[]> {
  const rows = await db
    .select()
    .from(diaryCategories)
    .where(options.includeInactive ? undefined : eq(diaryCategories.active, true))
    .orderBy(asc(diaryCategories.sortOrder), asc(diaryCategories.label));
  return rows.map(toDiaryCategory);
}

export async function createCategory(
  db: Database,
  request: CreateDiaryCategoryRequest,
  actor: AuditActor,
): Promise<DiaryCategory> {
  const [existing] = await db
    .select()
    .from(diaryCategories)
    .where(eq(diaryCategories.slug, request.slug))
    .limit(1);
  if (existing) throw new HttpError('conflict', 'A category with that key already exists.');

  const [row] = await db.insert(diaryCategories).values(request).returning();

  await recordAudit(db, {
    action: 'diary_category.create',
    actor,
    entityType: 'diary_category',
    entityId: row!.id,
    metadata: { slug: row!.slug },
  });

  return toDiaryCategory(row!);
}

/**
 * Categories are deactivated, never deleted, so an entry written last year
 * keeps the category it was filed under and a report of that year still adds
 * up.
 */
export async function updateCategory(
  db: Database,
  categoryId: string,
  request: UpdateDiaryCategoryRequest,
  actor: AuditActor,
): Promise<DiaryCategory> {
  const [row] = await db
    .update(diaryCategories)
    .set({ ...request, updatedAt: new Date() })
    .where(eq(diaryCategories.id, categoryId))
    .returning();
  if (!row) throw new HttpError('not_found', 'That category does not exist.');

  await recordAudit(db, {
    action: 'diary_category.update',
    actor,
    entityType: 'diary_category',
    entityId: categoryId,
    metadata: { fields: Object.keys(request).sort() },
  });

  return toDiaryCategory(row);
}

type EntryContext = {
  categories: Map<string, DiaryCategoryRow>;
  names: Map<string, string>;
  attachments: Map<string, AttachmentSummary[]>;
};

async function contextFor(db: Database, rows: readonly DiaryEntryRow[]): Promise<EntryContext> {
  const categoryRows = await db.select().from(diaryCategories);
  const userRows = await db.select({ id: users.id, displayName: users.displayName }).from(users);

  return {
    categories: new Map(categoryRows.map((row) => [row.id, row])),
    names: new Map(userRows.map((row) => [row.id, row.displayName])),
    attachments: await attachmentsForOwners(
      db,
      'diary_entry',
      rows.map((row) => row.id),
    ),
  };
}

function toDiaryEntry(keyRing: KeyRing, row: DiaryEntryRow, context: EntryContext): DiaryEntry {
  const category = context.categories.get(row.categoryId);
  return {
    id: row.id,
    participantId: row.participantId,
    categoryId: row.categoryId,
    categoryLabel: category?.label ?? 'Uncategorised',
    categoryColour: category?.colour ?? 'slate',
    body: decryptField(keyRing, BODY_COLUMN, row.bodyEnc),
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    recordedByName: row.recordedBy === null ? null : (context.names.get(row.recordedBy) ?? null),
    recordedAt: row.recordedAt.toISOString(),
    visibleToParticipant: row.visibleToParticipant,
    editedAt: row.editedAt?.toISOString() ?? null,
    editCount: row.editCount,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    attachments: context.attachments.get(row.id) ?? [],
  };
}

export async function findDiaryEntry(db: Database, entryId: string): Promise<DiaryEntryRow> {
  const [row] = await db.select().from(diaryEntries).where(eq(diaryEntries.id, entryId)).limit(1);
  if (!row) throw new HttpError('not_found', 'That diary entry does not exist.');
  return row;
}

export async function getDiaryEntry(
  db: Database,
  keyRing: KeyRing,
  entryId: string,
  principal: DiaryPrincipal,
): Promise<DiaryEntry> {
  const row = await findDiaryEntry(db, entryId);
  const entry = toDiaryEntry(keyRing, row, await contextFor(db, [row]));

  if (!canReadDiaryEntry(entry, viewerOf(principal, row.participantId))) {
    throw new HttpError('not_found', 'That diary entry does not exist.');
  }
  return entry;
}

/**
 * The list for one participant.
 *
 * Search runs after decryption, over the rows the date filter already narrowed
 * to. That is the cost of encrypted bodies, and it is bounded by the fact that
 * a search is always inside one participant's record (A9).
 */
export async function listDiaryEntries(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  query: DiaryQuery,
  principal: DiaryPrincipal,
  timeZone: string,
): Promise<DiaryEntry[]> {
  const filters = [eq(diaryEntries.participantId, participantId)];
  if (query.categoryId) filters.push(eq(diaryEntries.categoryId, query.categoryId));
  if (query.from) filters.push(gte(diaryEntries.occurredAt, dayStart(query.from, timeZone)));
  if (query.to) filters.push(lt(diaryEntries.occurredAt, dayEnd(query.to, timeZone)));

  const rows = await db
    .select()
    .from(diaryEntries)
    .where(and(...filters))
    .orderBy(desc(diaryEntries.occurredAt))
    // Searching needs more rows than it returns, because the filter that
    // matters can only be applied once the body is readable.
    .limit(query.search ? 1000 : query.limit);

  const context = await contextFor(db, rows);
  const viewer = viewerOf(principal, participantId);

  const entries = rows
    .map((row) => toDiaryEntry(keyRing, row, context))
    .filter((entry) => canReadDiaryEntry(entry, viewer))
    .filter((entry) => (query.search ? matchesDiarySearch(entry.body, query.search) : true));

  return entries.slice(0, query.limit);
}

/**
 * Local day boundaries, so "from 2026-07-28" means the day as it was lived
 * here rather than the day it was in UTC. The same function the check grid
 * uses, because two answers to "when does this day start" is one too many.
 */
function dayStart(isoDate: string, timeZone: string): Date {
  return zonedTimeToUtc(isoDate, 0, timeZone);
}

function dayEnd(isoDate: string, timeZone: string): Date {
  return zonedTimeToUtc(addDays(isoDate, 1), 0, timeZone);
}

/**
 * Creating an entry (doc 04 §8).
 *
 * Idempotent by the device-supplied id: a replayed request from a drained
 * outbox updates the same row rather than writing the shift up twice.
 */
export async function createDiaryEntry(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateDiaryEntryRequest,
  principal: DiaryPrincipal,
  actor: AuditActor,
): Promise<DiaryEntry> {
  const now = new Date();
  const occurredAt = new Date(request.occurredAt);

  const problem = occurredAtProblem(occurredAt, now);
  if (problem !== null) throw new HttpError('validation_failed', problem);

  const [category] = await db
    .select()
    .from(diaryCategories)
    .where(and(eq(diaryCategories.id, request.categoryId), eq(diaryCategories.active, true)))
    .limit(1);
  if (!category)
    throw new HttpError('validation_failed', 'That category is not one of the options.');

  const [existing] = await db
    .select()
    .from(diaryEntries)
    .where(eq(diaryEntries.id, request.id))
    .limit(1);
  if (existing && existing.participantId !== participantId) {
    throw new HttpError('conflict', 'That entry id belongs to a different participant.');
  }

  const [row] = await db
    .insert(diaryEntries)
    .values({
      id: request.id,
      participantId,
      categoryId: request.categoryId,
      bodyEnc: encryptField(keyRing, BODY_COLUMN, request.body),
      occurredAt,
      recordedBy: principal.userId,
      recordedAt: now,
      receivedAt: now,
      visibleToParticipant: request.visibleToParticipant,
      deviceId: principal.deviceId,
    })
    .onConflictDoUpdate({
      target: diaryEntries.id,
      set: {
        categoryId: request.categoryId,
        bodyEnc: encryptField(keyRing, BODY_COLUMN, request.body),
        occurredAt,
        visibleToParticipant: request.visibleToParticipant,
        updatedAt: now,
      },
    })
    .returning();

  await claimAttachments(db, 'diary_entry', row!.id, participantId, request.attachmentIds);

  await recordAudit(db, {
    action: existing ? 'diary_entry.update' : 'diary_entry.create',
    actor,
    entityType: 'diary_entry',
    entityId: row!.id,
    participantId,
    // The category and the shape of it. Never the body: it is about a person.
    metadata: {
      category: category.slug,
      visibleToParticipant: request.visibleToParticipant,
      attachments: request.attachmentIds.length,
    },
  });

  return toDiaryEntry(keyRing, row!, await contextFor(db, [row!]));
}

type RevisionField = 'body' | 'category' | 'occurred_at' | 'visibility';

/**
 * Editing an entry (doc 01 §6).
 *
 * Same rule as a check entry: the original is preserved. Each changed field
 * writes one history row holding the old and the new value encrypted together,
 * so the history cannot become a way to read what the entry keeps encrypted.
 */
export async function updateDiaryEntry(
  db: Database,
  keyRing: KeyRing,
  entryId: string,
  request: UpdateDiaryEntryRequest,
  principal: DiaryPrincipal,
  actor: AuditActor,
): Promise<DiaryEntry> {
  const now = new Date();
  const row = await findDiaryEntry(db, entryId);

  if (row.deletedAt !== null) {
    throw new HttpError('conflict', 'That diary entry has been deleted.');
  }

  const body = decryptField(keyRing, BODY_COLUMN, row.bodyEnc);

  const changes: { field: RevisionField; old: string | null; next: string | null }[] = [];
  const columns: Partial<typeof diaryEntries.$inferInsert> = {};

  if (request.body !== undefined && request.body !== body) {
    changes.push({ field: 'body', old: body, next: request.body });
    columns.bodyEnc = encryptField(keyRing, BODY_COLUMN, request.body);
  }

  if (request.categoryId !== undefined && request.categoryId !== row.categoryId) {
    const [category] = await db
      .select()
      .from(diaryCategories)
      .where(and(eq(diaryCategories.id, request.categoryId), eq(diaryCategories.active, true)))
      .limit(1);
    if (!category) {
      throw new HttpError('validation_failed', 'That category is not one of the options.');
    }
    changes.push({ field: 'category', old: row.categoryId, next: request.categoryId });
    columns.categoryId = request.categoryId;
  }

  if (request.occurredAt !== undefined) {
    const occurredAt = new Date(request.occurredAt);
    const problem = occurredAtProblem(occurredAt, now);
    if (problem !== null) throw new HttpError('validation_failed', problem);
    if (occurredAt.getTime() !== row.occurredAt.getTime()) {
      changes.push({
        field: 'occurred_at',
        old: row.occurredAt.toISOString(),
        next: occurredAt.toISOString(),
      });
      columns.occurredAt = occurredAt;
    }
  }

  if (
    request.visibleToParticipant !== undefined &&
    request.visibleToParticipant !== row.visibleToParticipant
  ) {
    changes.push({
      field: 'visibility',
      old: String(row.visibleToParticipant),
      next: String(request.visibleToParticipant),
    });
    columns.visibleToParticipant = request.visibleToParticipant;
  }

  // Saving a form nobody changed is not an edit, and should not leave a
  // history row saying it was.
  if (changes.length === 0) {
    return toDiaryEntry(keyRing, row, await contextFor(db, [row]));
  }

  const updated = await db.transaction(async (tx) => {
    for (const change of changes) {
      await tx.insert(diaryEntryRevisions).values({
        entryId,
        field: change.field,
        valuesEnc: encryptField(
          keyRing,
          REVISION_COLUMN,
          JSON.stringify({ old: change.old, new: change.next }),
        ),
        changedBy: principal.userId,
        changedAt: now,
        reason: request.reason ?? null,
      });
    }

    const [result] = await tx
      .update(diaryEntries)
      .set({ ...columns, editedAt: now, editCount: row.editCount + 1, updatedAt: now })
      .where(eq(diaryEntries.id, entryId))
      .returning();
    return result!;
  });

  await recordAudit(db, {
    action: 'diary_entry.edit',
    actor,
    entityType: 'diary_entry',
    entityId: entryId,
    participantId: row.participantId,
    metadata: {
      fields: changes.map((change) => change.field).sort(),
      editedAnothersEntry: row.recordedBy !== principal.userId,
    },
  });

  return toDiaryEntry(keyRing, updated, await contextFor(db, [updated]));
}

/**
 * Soft delete, admin only and audited (doc 04 §8).
 *
 * Nothing is hard-deleted while retention applies. The entry stops appearing
 * and the row stays, which is the difference between a record correction and a
 * record disappearing.
 */
export async function deleteDiaryEntry(
  db: Database,
  entryId: string,
  principal: DiaryPrincipal,
  actor: AuditActor,
): Promise<void> {
  const row = await findDiaryEntry(db, entryId);
  if (row.deletedAt !== null) return;

  const now = new Date();
  await db
    .update(diaryEntries)
    .set({ deletedAt: now, deletedBy: principal.userId, updatedAt: now })
    .where(eq(diaryEntries.id, entryId));

  await recordAudit(db, {
    action: 'diary_entry.delete',
    actor,
    entityType: 'diary_entry',
    entityId: entryId,
    participantId: row.participantId,
    metadata: { recordedBy: row.recordedBy },
  });
}

export async function listDiaryRevisions(
  db: Database,
  keyRing: KeyRing,
  entryId: string,
): Promise<DiaryRevision[]> {
  const rows = await db
    .select({ revision: diaryEntryRevisions, changedByName: users.displayName })
    .from(diaryEntryRevisions)
    .leftJoin(users, eq(users.id, diaryEntryRevisions.changedBy))
    .where(eq(diaryEntryRevisions.entryId, entryId))
    .orderBy(asc(diaryEntryRevisions.changedAt));

  return rows.map(({ revision, changedByName }) => {
    const pair = JSON.parse(decryptField(keyRing, REVISION_COLUMN, revision.valuesEnc)) as {
      old: string | null;
      new: string | null;
    };
    return {
      id: revision.id,
      field: revision.field,
      oldValue: pair.old,
      newValue: pair.new,
      changedBy: revision.changedBy,
      changedByName,
      changedAt: revision.changedAt.toISOString(),
      reason: revision.reason,
    };
  });
}

/**
 * The participant timeline (doc 04 §3, doc 06 §4.2).
 *
 * Checks and diary in one list. The merge itself is in `@vigilo/shared` so the
 * offline device produces the same order from its local tables, and a handover
 * read on a phone with no signal matches the one read in the office.
 */
export async function participantTimeline(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: Date,
  to: Date,
  principal: DiaryPrincipal,
): Promise<TimelineItem[]> {
  const [windows, rows] = await Promise.all([
    listWindows(db, keyRing, participantId, from, to),
    db
      .select()
      .from(diaryEntries)
      .where(
        and(
          eq(diaryEntries.participantId, participantId),
          gte(diaryEntries.occurredAt, from),
          lt(diaryEntries.occurredAt, to),
          principal.role === 'admin' ? undefined : isNull(diaryEntries.deletedAt),
        ),
      )
      .orderBy(desc(diaryEntries.occurredAt)),
  ]);

  const context = await contextFor(db, rows);
  const viewer = viewerOf(principal, participantId);
  const entries = rows
    .map((row) => toDiaryEntry(keyRing, row, context))
    .filter((entry) => canReadDiaryEntry(entry, viewer));

  return buildTimeline(windows, entries);
}
