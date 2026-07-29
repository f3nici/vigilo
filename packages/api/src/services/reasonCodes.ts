import { asc, eq } from 'drizzle-orm';
import type {
  CreateMissedReasonCodeRequest,
  MissedReasonCode,
  UpdateMissedReasonCodeRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { missedReasonCodes, type MissedReasonCodeRow } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Missed reason codes (doc 03 §6).
 *
 * Admin-configurable, and seeded by migration 0008 rather than hard-coded, so
 * the list is the organisation's vocabulary rather than ours. A code in use is
 * deactivated, never deleted, because a window from last March still points at
 * the reason it was given.
 */

export function toCode(row: MissedReasonCodeRow): MissedReasonCode {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    requiresNote: row.requiresNote,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

export async function listReasonCodes(
  db: Database,
  options: { includeInactive?: boolean } = {},
): Promise<MissedReasonCode[]> {
  const rows = await db
    .select()
    .from(missedReasonCodes)
    .where(options.includeInactive ? undefined : eq(missedReasonCodes.active, true))
    .orderBy(asc(missedReasonCodes.sortOrder), asc(missedReasonCodes.label));

  return rows.map(toCode);
}

export async function createReasonCode(
  db: Database,
  request: CreateMissedReasonCodeRequest,
  actor: AuditActor,
): Promise<MissedReasonCode> {
  let created: MissedReasonCodeRow;
  try {
    const [row] = await db
      .insert(missedReasonCodes)
      .values({
        code: request.code,
        label: request.label,
        requiresNote: request.requiresNote,
        sortOrder: request.sortOrder,
      })
      .returning();
    created = row!;
  } catch (error) {
    if (error instanceof Error && /unique|duplicate key/i.test(error.message)) {
      throw new HttpError('conflict', 'A reason with that code already exists.');
    }
    throw error;
  }

  await recordAudit(db, {
    action: 'reason_code.create',
    actor,
    entityType: 'missed_reason_code',
    entityId: created.id,
    metadata: { code: created.code },
  });

  return toCode(created);
}

export async function updateReasonCode(
  db: Database,
  id: string,
  request: UpdateMissedReasonCodeRequest,
  actor: AuditActor,
): Promise<MissedReasonCode> {
  const changes: Partial<typeof missedReasonCodes.$inferInsert> = { updatedAt: new Date() };
  if (request.code !== undefined) changes.code = request.code;
  if (request.label !== undefined) changes.label = request.label;
  if (request.requiresNote !== undefined) changes.requiresNote = request.requiresNote;
  if (request.sortOrder !== undefined) changes.sortOrder = request.sortOrder;
  if (request.active !== undefined) changes.active = request.active;

  const [updated] = await db
    .update(missedReasonCodes)
    .set(changes)
    .where(eq(missedReasonCodes.id, id))
    .returning();

  if (!updated) throw new HttpError('not_found', 'That reason does not exist.');

  await recordAudit(db, {
    action: 'reason_code.update',
    actor,
    entityType: 'missed_reason_code',
    entityId: id,
    metadata: { fields: Object.keys(request).sort() },
  });

  return toCode(updated);
}
