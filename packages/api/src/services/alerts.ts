import { and, asc, eq } from 'drizzle-orm';
import type { CreateAlertRequest, ParticipantAlert, UpdateAlertRequest } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { participantAlerts, type ParticipantAlertRow } from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, encryptField } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Participant alerts (doc 03 §3): allergies, seizure plans, communication
 * needs. Pinned above every screen for that participant, so the ordering is
 * admin-controlled rather than whatever the database returns.
 *
 * Severity says how urgently a human should read the flag. It is never a
 * judgement about a recorded value, which Vigilo does not make (CLAUDE.md).
 */

const TEXT_COLUMN = 'participant_alerts.text_enc';

function toAlert(keyRing: KeyRing, row: ParticipantAlertRow): ParticipantAlert {
  return {
    id: row.id,
    participantId: row.participantId,
    kind: row.kind,
    severity: row.severity,
    text: decryptField(keyRing, TEXT_COLUMN, row.textEnc),
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAlerts(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<ParticipantAlert[]> {
  const filters = [eq(participantAlerts.participantId, participantId)];
  if (!options.includeInactive) filters.push(eq(participantAlerts.active, true));

  const rows = await db
    .select()
    .from(participantAlerts)
    .where(and(...filters))
    .orderBy(asc(participantAlerts.sortOrder), asc(participantAlerts.createdAt));

  return rows.map((row) => toAlert(keyRing, row));
}

export async function createAlert(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateAlertRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<ParticipantAlert> {
  const [row] = await db
    .insert(participantAlerts)
    .values({
      participantId,
      kind: request.kind,
      severity: request.severity,
      textEnc: encryptField(keyRing, TEXT_COLUMN, request.text),
      sortOrder: request.sortOrder ?? 0,
      active: request.active ?? true,
      createdBy,
    })
    .returning();

  await recordAudit(db, {
    action: 'alert.create',
    actor,
    entityType: 'participant_alert',
    entityId: row!.id,
    participantId,
    // Kind and severity are structure, not content. The text stays encrypted.
    metadata: { kind: request.kind, severity: request.severity },
  });

  return toAlert(keyRing, row!);
}

async function findAlert(
  db: Database,
  participantId: string,
  alertId: string,
): Promise<ParticipantAlertRow> {
  const [row] = await db
    .select()
    .from(participantAlerts)
    .where(
      and(eq(participantAlerts.id, alertId), eq(participantAlerts.participantId, participantId)),
    )
    .limit(1);

  if (!row) throw new HttpError('not_found', 'That alert does not exist.');
  return row;
}

export async function updateAlert(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  alertId: string,
  request: UpdateAlertRequest,
  actor: AuditActor,
): Promise<ParticipantAlert> {
  await findAlert(db, participantId, alertId);

  const changes: Partial<typeof participantAlerts.$inferInsert> = { updatedAt: new Date() };
  if (request.kind !== undefined) changes.kind = request.kind;
  if (request.severity !== undefined) changes.severity = request.severity;
  if (request.text !== undefined)
    changes.textEnc = encryptField(keyRing, TEXT_COLUMN, request.text);
  if (request.sortOrder !== undefined) changes.sortOrder = request.sortOrder;
  if (request.active !== undefined) changes.active = request.active;

  const [updated] = await db
    .update(participantAlerts)
    .set(changes)
    .where(eq(participantAlerts.id, alertId))
    .returning();

  await recordAudit(db, {
    action: 'alert.update',
    actor,
    entityType: 'participant_alert',
    entityId: alertId,
    participantId,
    metadata: { fields: Object.keys(request).sort() },
  });

  return toAlert(keyRing, updated!);
}

/**
 * Retiring an alert deactivates it. The row stays, because "this person was
 * flagged for a peanut allergy until March" is part of the record
 * (CLAUDE.md: nothing is hard-deleted while retention applies).
 */
export async function deactivateAlert(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  alertId: string,
  actor: AuditActor,
): Promise<ParticipantAlert> {
  await findAlert(db, participantId, alertId);

  const [updated] = await db
    .update(participantAlerts)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(participantAlerts.id, alertId))
    .returning();

  await recordAudit(db, {
    action: 'alert.deactivate',
    actor,
    entityType: 'participant_alert',
    entityId: alertId,
    participantId,
  });

  return toAlert(keyRing, updated!);
}
