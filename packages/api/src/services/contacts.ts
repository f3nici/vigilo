import { and, asc, eq, ne } from 'drizzle-orm';
import type {
  CreateContactRequest,
  EmergencyContact,
  EmergencyPlan,
  PutEmergencyPlanRequest,
  UpdateContactRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  emergencyContacts,
  emergencyPlans,
  type EmergencyContactRow,
  type EmergencyPlanRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, decryptOptional, encryptField, encryptOptional } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Emergency contacts and the emergency plan (doc 03 §3).
 *
 * Both have to be readable offline at all times, which is why they are part of
 * the participant record rather than something fetched on demand. Contacts are
 * ordered with one designated primary: in an emergency nobody scrolls.
 */

const CONTACT = {
  name: 'emergency_contacts.name_enc',
  relationship: 'emergency_contacts.relationship_enc',
  phonePrimary: 'emergency_contacts.phone_primary_enc',
  phoneSecondary: 'emergency_contacts.phone_secondary_enc',
  email: 'emergency_contacts.email_enc',
  notes: 'emergency_contacts.notes_enc',
} as const;

const PLAN_BODY_COLUMN = 'emergency_plans.body_enc';

function toContact(keyRing: KeyRing, row: EmergencyContactRow): EmergencyContact {
  return {
    id: row.id,
    participantId: row.participantId,
    name: decryptField(keyRing, CONTACT.name, row.nameEnc),
    relationship: decryptField(keyRing, CONTACT.relationship, row.relationshipEnc),
    phonePrimary: decryptField(keyRing, CONTACT.phonePrimary, row.phonePrimaryEnc),
    phoneSecondary: decryptOptional(keyRing, CONTACT.phoneSecondary, row.phoneSecondaryEnc),
    email: decryptOptional(keyRing, CONTACT.email, row.emailEnc),
    isPrimary: row.isPrimary,
    sortOrder: row.sortOrder,
    notes: decryptOptional(keyRing, CONTACT.notes, row.notesEnc),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listContacts(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
): Promise<EmergencyContact[]> {
  const rows = await db
    .select()
    .from(emergencyContacts)
    .where(eq(emergencyContacts.participantId, participantId))
    .orderBy(
      // The primary contact first, whatever anyone set the sort order to.
      asc(emergencyContacts.sortOrder),
      asc(emergencyContacts.createdAt),
    );

  return rows
    .map((row) => toContact(keyRing, row))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/** At most one primary contact, so demote whoever held it. */
async function clearOtherPrimaries(
  db: Database,
  participantId: string,
  keepId: string,
): Promise<void> {
  await db
    .update(emergencyContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(emergencyContacts.participantId, participantId),
        eq(emergencyContacts.isPrimary, true),
        ne(emergencyContacts.id, keepId),
      ),
    );
}

export async function createContact(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateContactRequest,
  actor: AuditActor,
): Promise<EmergencyContact> {
  const [row] = await db
    .insert(emergencyContacts)
    .values({
      participantId,
      nameEnc: encryptField(keyRing, CONTACT.name, request.name),
      relationshipEnc: encryptField(keyRing, CONTACT.relationship, request.relationship),
      phonePrimaryEnc: encryptField(keyRing, CONTACT.phonePrimary, request.phonePrimary),
      phoneSecondaryEnc: encryptOptional(
        keyRing,
        CONTACT.phoneSecondary,
        request.phoneSecondary ?? null,
      ),
      emailEnc: encryptOptional(keyRing, CONTACT.email, request.email ?? null),
      isPrimary: request.isPrimary ?? false,
      sortOrder: request.sortOrder ?? 0,
      notesEnc: encryptOptional(keyRing, CONTACT.notes, request.notes ?? null),
    })
    .returning();

  if (row!.isPrimary) await clearOtherPrimaries(db, participantId, row!.id);

  await recordAudit(db, {
    action: 'contact.create',
    actor,
    entityType: 'emergency_contact',
    entityId: row!.id,
    participantId,
    metadata: { isPrimary: row!.isPrimary },
  });

  return toContact(keyRing, row!);
}

async function findContact(
  db: Database,
  participantId: string,
  contactId: string,
): Promise<EmergencyContactRow> {
  const [row] = await db
    .select()
    .from(emergencyContacts)
    .where(
      and(eq(emergencyContacts.id, contactId), eq(emergencyContacts.participantId, participantId)),
    )
    .limit(1);

  if (!row) throw new HttpError('not_found', 'That contact does not exist.');
  return row;
}

export async function updateContact(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  contactId: string,
  request: UpdateContactRequest,
  actor: AuditActor,
): Promise<EmergencyContact> {
  await findContact(db, participantId, contactId);

  const changes: Partial<typeof emergencyContacts.$inferInsert> = { updatedAt: new Date() };
  if (request.name !== undefined)
    changes.nameEnc = encryptField(keyRing, CONTACT.name, request.name);
  if (request.relationship !== undefined) {
    changes.relationshipEnc = encryptField(keyRing, CONTACT.relationship, request.relationship);
  }
  if (request.phonePrimary !== undefined) {
    changes.phonePrimaryEnc = encryptField(keyRing, CONTACT.phonePrimary, request.phonePrimary);
  }
  if ('phoneSecondary' in request) {
    changes.phoneSecondaryEnc = encryptOptional(
      keyRing,
      CONTACT.phoneSecondary,
      request.phoneSecondary ?? null,
    );
  }
  if ('email' in request) {
    changes.emailEnc = encryptOptional(keyRing, CONTACT.email, request.email ?? null);
  }
  if ('notes' in request) {
    changes.notesEnc = encryptOptional(keyRing, CONTACT.notes, request.notes ?? null);
  }
  if (request.isPrimary !== undefined) changes.isPrimary = request.isPrimary;
  if (request.sortOrder !== undefined) changes.sortOrder = request.sortOrder;

  const [updated] = await db
    .update(emergencyContacts)
    .set(changes)
    .where(eq(emergencyContacts.id, contactId))
    .returning();

  if (updated!.isPrimary) await clearOtherPrimaries(db, participantId, contactId);

  await recordAudit(db, {
    action: 'contact.update',
    actor,
    entityType: 'emergency_contact',
    entityId: contactId,
    participantId,
    metadata: { fields: Object.keys(request).sort() },
  });

  return toContact(keyRing, updated!);
}

/**
 * A contact who is no longer a contact is removed outright. This is the one
 * place a hard delete is right: a phone number for someone who has asked not to
 * be called is a liability, not a record, and nothing else references the row.
 */
export async function deleteContact(
  db: Database,
  participantId: string,
  contactId: string,
  actor: AuditActor,
): Promise<void> {
  await findContact(db, participantId, contactId);
  await db.delete(emergencyContacts).where(eq(emergencyContacts.id, contactId));

  await recordAudit(db, {
    action: 'contact.delete',
    actor,
    entityType: 'emergency_contact',
    entityId: contactId,
    participantId,
  });
}

function toPlan(keyRing: KeyRing, row: EmergencyPlanRow): EmergencyPlan {
  return {
    participantId: row.participantId,
    title: row.title,
    body: decryptField(keyRing, PLAN_BODY_COLUMN, row.bodyEnc),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export async function getEmergencyPlan(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
): Promise<EmergencyPlan | null> {
  const [row] = await db
    .select()
    .from(emergencyPlans)
    .where(eq(emergencyPlans.participantId, participantId))
    .limit(1);

  return row ? toPlan(keyRing, row) : null;
}

/** One plan per participant, so writing it is an upsert rather than a create. */
export async function putEmergencyPlan(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: PutEmergencyPlanRequest,
  updatedBy: string,
  actor: AuditActor,
): Promise<EmergencyPlan> {
  const [row] = await db
    .insert(emergencyPlans)
    .values({
      participantId,
      title: request.title,
      bodyEnc: encryptField(keyRing, PLAN_BODY_COLUMN, request.body),
      updatedBy,
    })
    .onConflictDoUpdate({
      target: emergencyPlans.participantId,
      set: {
        title: request.title,
        bodyEnc: encryptField(keyRing, PLAN_BODY_COLUMN, request.body),
        updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();

  await recordAudit(db, {
    action: 'emergency_plan.write',
    actor,
    entityType: 'emergency_plan',
    entityId: row!.id,
    participantId,
  });

  return toPlan(keyRing, row!);
}
