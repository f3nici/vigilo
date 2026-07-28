import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type CreateParticipantRequest,
  type ParticipantAccess,
  type ParticipantDetail,
  type ParticipantSummary,
  type UpdateParticipantRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { participants, type Participant } from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { blindIndex } from '../crypto/keys.js';
import { decryptField, decryptOptional, encryptField, encryptOptional } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { listAlerts } from './alerts.js';
import { getEmergencyPlan, listContacts } from './contacts.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Participant records (doc 01 §4, doc 03 §3).
 *
 * Everything identifying is encrypted with the column name as additional
 * authenticated data, so a ciphertext cannot be moved from one column to
 * another. The two blind indexes allow exact lookup without decrypting: NDIS
 * number, which is unique and is what stops the same person being added twice,
 * and surname.
 *
 * Nothing here deletes. Archiving sets a status and keeps the row (CLAUDE.md).
 */

/** The AAD for each encrypted column. Must match between write and read. */
export const COLUMN = {
  firstName: 'participants.first_name_enc',
  lastName: 'participants.last_name_enc',
  preferredName: 'participants.preferred_name_enc',
  dateOfBirth: 'participants.dob_enc',
  ndisNumber: 'participants.ndis_number_enc',
  address: 'participants.address_enc',
  phone: 'participants.phone_enc',
  email: 'participants.email_enc',
  notes: 'participants.notes_enc',
} as const;

const NDIS_BIDX_COLUMN = 'participants.ndis_number_bidx';
const NAME_BIDX_COLUMN = 'participants.name_search_bidx';

const ADMIN_ACCESS: ParticipantAccess = { kind: 'all', expiresAt: null };

export function toSummary(
  keyRing: KeyRing,
  row: Participant,
  access: ParticipantAccess = ADMIN_ACCESS,
): ParticipantSummary {
  return {
    id: row.id,
    firstName: decryptField(keyRing, COLUMN.firstName, row.firstNameEnc),
    lastName: decryptField(keyRing, COLUMN.lastName, row.lastNameEnc),
    preferredName: decryptOptional(keyRing, COLUMN.preferredName, row.preferredNameEnc),
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    access,
  };
}

function toRecord(
  keyRing: KeyRing,
  row: Participant,
  access: ParticipantAccess,
): Omit<ParticipantDetail, 'alerts' | 'contacts' | 'emergencyPlan'> {
  return {
    ...toSummary(keyRing, row, access),
    dateOfBirth: decryptField(keyRing, COLUMN.dateOfBirth, row.dobEnc),
    ndisNumber: decryptField(keyRing, COLUMN.ndisNumber, row.ndisNumberEnc),
    address: decryptOptional(keyRing, COLUMN.address, row.addressEnc),
    phone: decryptOptional(keyRing, COLUMN.phone, row.phoneEnc),
    email: decryptOptional(keyRing, COLUMN.email, row.emailEnc),
    notes: decryptOptional(keyRing, COLUMN.notes, row.notesEnc),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ListOptions = {
  /** Archived records stay and stay findable, they are just not the default. */
  includeArchived?: boolean;
};

export async function listParticipants(
  db: Database,
  keyRing: KeyRing,
  ids: string[] | 'all',
  access: Map<string, ParticipantAccess>,
  options: ListOptions = {},
): Promise<ParticipantSummary[]> {
  if (ids !== 'all' && ids.length === 0) return [];

  const filters = [];
  if (ids !== 'all') filters.push(inArray(participants.id, ids));
  if (!options.includeArchived) filters.push(eq(participants.status, 'active'));

  const rows = await db
    .select()
    .from(participants)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(participants.createdAt));

  return rows.map((row) => toSummary(keyRing, row, access.get(row.id) ?? ADMIN_ACCESS));
}

export async function findParticipant(db: Database, id: string): Promise<Participant> {
  const [row] = await db.select().from(participants).where(eq(participants.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That participant does not exist.');
  return row;
}

/** The overview screen's data: the record, its alerts, contacts and plan. */
export async function getParticipantDetail(
  db: Database,
  keyRing: KeyRing,
  id: string,
  access: ParticipantAccess,
): Promise<ParticipantDetail> {
  const row = await findParticipant(db, id);
  const [alerts, contacts, emergencyPlan] = await Promise.all([
    listAlerts(db, keyRing, id),
    listContacts(db, keyRing, id),
    getEmergencyPlan(db, keyRing, id),
  ]);

  return { ...toRecord(keyRing, row, access), alerts, contacts, emergencyPlan };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique|duplicate key/i.test(error.message);
}

export async function createParticipant(
  db: Database,
  keyRing: KeyRing,
  request: CreateParticipantRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<ParticipantSummary> {
  let created: Participant;
  try {
    const [row] = await db
      .insert(participants)
      .values({
        firstNameEnc: encryptField(keyRing, COLUMN.firstName, request.firstName),
        lastNameEnc: encryptField(keyRing, COLUMN.lastName, request.lastName),
        preferredNameEnc: encryptOptional(
          keyRing,
          COLUMN.preferredName,
          request.preferredName ?? null,
        ),
        nameSearchBidx: blindIndex(keyRing, NAME_BIDX_COLUMN, request.lastName),
        dobEnc: encryptField(keyRing, COLUMN.dateOfBirth, request.dateOfBirth),
        ndisNumberEnc: encryptField(keyRing, COLUMN.ndisNumber, request.ndisNumber),
        ndisNumberBidx: blindIndex(keyRing, NDIS_BIDX_COLUMN, request.ndisNumber),
        addressEnc: encryptOptional(keyRing, COLUMN.address, request.address ?? null),
        phoneEnc: encryptOptional(keyRing, COLUMN.phone, request.phone ?? null),
        emailEnc: encryptOptional(keyRing, COLUMN.email, request.email ?? null),
        notesEnc: encryptOptional(keyRing, COLUMN.notes, request.notes ?? null),
        createdBy,
      })
      .returning();
    created = row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(
        'conflict',
        'A participant with that NDIS number already exists. Search for them instead of adding them again.',
      );
    }
    throw error;
  }

  await recordAudit(db, {
    action: 'participant.create',
    actor,
    entityType: 'participant',
    entityId: created.id,
    participantId: created.id,
    // The id and nothing else. A name in the audit log would defeat encrypting
    // it in the table it came from.
    metadata: {},
  });

  return toSummary(keyRing, created, ADMIN_ACCESS);
}

export async function updateParticipant(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: UpdateParticipantRequest,
  actor: AuditActor,
): Promise<ParticipantSummary> {
  await findParticipant(db, id);

  const changes: Partial<typeof participants.$inferInsert> = { updatedAt: new Date() };

  if (request.firstName !== undefined) {
    changes.firstNameEnc = encryptField(keyRing, COLUMN.firstName, request.firstName);
  }
  if (request.lastName !== undefined) {
    changes.lastNameEnc = encryptField(keyRing, COLUMN.lastName, request.lastName);
    // The surname blind index is derived from it, so it moves too.
    changes.nameSearchBidx = blindIndex(keyRing, NAME_BIDX_COLUMN, request.lastName);
  }
  if ('preferredName' in request) {
    changes.preferredNameEnc = encryptOptional(
      keyRing,
      COLUMN.preferredName,
      request.preferredName ?? null,
    );
  }
  if (request.dateOfBirth !== undefined) {
    changes.dobEnc = encryptField(keyRing, COLUMN.dateOfBirth, request.dateOfBirth);
  }
  if (request.ndisNumber !== undefined) {
    changes.ndisNumberEnc = encryptField(keyRing, COLUMN.ndisNumber, request.ndisNumber);
    changes.ndisNumberBidx = blindIndex(keyRing, NDIS_BIDX_COLUMN, request.ndisNumber);
  }
  if ('address' in request) {
    changes.addressEnc = encryptOptional(keyRing, COLUMN.address, request.address ?? null);
  }
  if ('phone' in request) {
    changes.phoneEnc = encryptOptional(keyRing, COLUMN.phone, request.phone ?? null);
  }
  if ('email' in request) {
    changes.emailEnc = encryptOptional(keyRing, COLUMN.email, request.email ?? null);
  }
  if ('notes' in request) {
    changes.notesEnc = encryptOptional(keyRing, COLUMN.notes, request.notes ?? null);
  }

  let updated: Participant;
  try {
    const [row] = await db
      .update(participants)
      .set(changes)
      .where(eq(participants.id, id))
      .returning();
    updated = row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError('conflict', 'Another participant already has that NDIS number.');
    }
    throw error;
  }

  await recordAudit(db, {
    action: 'participant.update',
    actor,
    entityType: 'participant',
    entityId: id,
    participantId: id,
    // Which fields moved, never what they moved to.
    metadata: { fields: Object.keys(request).sort() },
  });

  return toSummary(keyRing, updated, ADMIN_ACCESS);
}

/**
 * Archive, never delete. The row stays, its history stays, and the record can
 * be brought back if someone returns to the service (doc 01 §4).
 */
export async function archiveParticipant(
  db: Database,
  keyRing: KeyRing,
  id: string,
  actor: AuditActor,
): Promise<ParticipantSummary> {
  const [updated] = await db
    .update(participants)
    .set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(participants.id, id))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That participant does not exist.');

  await recordAudit(db, {
    action: 'participant.archive',
    actor,
    entityType: 'participant',
    entityId: id,
    participantId: id,
  });

  return toSummary(keyRing, updated, ADMIN_ACCESS);
}

export async function restoreParticipant(
  db: Database,
  keyRing: KeyRing,
  id: string,
  actor: AuditActor,
): Promise<ParticipantSummary> {
  const [updated] = await db
    .update(participants)
    .set({ status: 'active', archivedAt: null, updatedAt: new Date() })
    .where(eq(participants.id, id))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That participant does not exist.');

  await recordAudit(db, {
    action: 'participant.restore',
    actor,
    entityType: 'participant',
    entityId: id,
    participantId: id,
  });

  return toSummary(keyRing, updated, ADMIN_ACCESS);
}

/**
 * Exact match on the NDIS blind index (doc 04 §3). Exact only: the index is an
 * HMAC, so there is no prefix search and no range, by design.
 */
export async function lookupByNdisNumber(
  db: Database,
  keyRing: KeyRing,
  ndisNumber: string,
  actor: AuditActor,
): Promise<ParticipantSummary | null> {
  const [row] = await db
    .select()
    .from(participants)
    .where(eq(participants.ndisNumberBidx, blindIndex(keyRing, NDIS_BIDX_COLUMN, ndisNumber)))
    .limit(1);

  await recordAudit(db, {
    action: 'participant.lookup',
    actor,
    entityType: 'participant',
    entityId: row?.id ?? null,
    participantId: row?.id ?? null,
    // Whether it hit, never the number that was searched for.
    metadata: { by: 'ndis_number', found: row !== undefined },
  });

  return row ? toSummary(keyRing, row, ADMIN_ACCESS) : null;
}

/** So a caller can tell an empty scope from an empty database. */
export async function countParticipants(db: Database): Promise<number> {
  const [row] = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from participants`,
  );
  return Number(row?.count ?? 0);
}
