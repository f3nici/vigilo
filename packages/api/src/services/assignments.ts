import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  isAssignmentEffective,
  type CreateAssignmentRequest,
  type ParticipantAssignment,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { participantAssignments, syncScopeChanges, users } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Who can see whom (doc 01 §4.1, doc 03 §2).
 *
 * A standing assignment lasts until it is revoked. A temporary grant carries a
 * mandatory expiry and reason, behaves identically until it expires, and then
 * simply stops working: nothing has to run for access to end.
 *
 * Every grant and revocation also writes a `sync_scope_changes` row, which is
 * how a device learns to download or purge that participant's local data
 * (doc 04 §4). It is written here because this is the only place that knows a
 * scope actually changed.
 */

type AssignmentRow = typeof participantAssignments.$inferSelect;

function toAssignment(
  row: AssignmentRow,
  user: { displayName: string; role: ParticipantAssignment['userRole'] },
  now: Date,
): ParticipantAssignment {
  return {
    id: row.id,
    participantId: row.participantId,
    userId: row.userId,
    userDisplayName: user.displayName,
    userRole: user.role,
    kind: row.kind,
    reason: row.reason,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    effective: isAssignmentEffective(
      {
        participantId: row.participantId,
        kind: row.kind,
        revokedAt: row.revokedAt,
        expiresAt: row.expiresAt,
      },
      now,
    ),
  };
}

const withUser = {
  assignment: participantAssignments,
  displayName: users.displayName,
  role: users.role,
};

export async function listAssignments(
  db: Database,
  participantId: string,
  now = new Date(),
): Promise<ParticipantAssignment[]> {
  const rows = await db
    .select(withUser)
    .from(participantAssignments)
    .innerJoin(users, eq(users.id, participantAssignments.userId))
    .where(eq(participantAssignments.participantId, participantId))
    .orderBy(desc(participantAssignments.grantedAt));

  return rows.map((row) =>
    toAssignment(row.assignment, { displayName: row.displayName, role: row.role }, now),
  );
}

export async function listAssignmentsForUser(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<ParticipantAssignment[]> {
  const rows = await db
    .select(withUser)
    .from(participantAssignments)
    .innerJoin(users, eq(users.id, participantAssignments.userId))
    .where(eq(participantAssignments.userId, userId))
    .orderBy(desc(participantAssignments.grantedAt));

  return rows.map((row) =>
    toAssignment(row.assignment, { displayName: row.displayName, role: row.role }, now),
  );
}

export async function grantAssignment(
  db: Database,
  participantId: string,
  request: CreateAssignmentRequest,
  grantedBy: string,
  actor: AuditActor,
): Promise<ParticipantAssignment> {
  const [target] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);

  if (!target) throw new HttpError('not_found', 'That account does not exist.');
  if (target.status !== 'active') {
    throw new HttpError('conflict', 'That account is suspended, so it cannot be given access.');
  }
  if (target.role === 'participant') {
    // A self-access account sees its own record and nothing else, ever.
    throw new HttpError(
      'validation_failed',
      'A participant account cannot be assigned to a participant record.',
    );
  }

  const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
  if (expiresAt !== null && expiresAt <= new Date()) {
    throw new HttpError('validation_failed', 'That expiry has already passed.');
  }

  // An assignment that is already in force does not need a second row, and a
  // duplicate would make revoking it look like it had not worked.
  const existing = await db
    .select()
    .from(participantAssignments)
    .where(
      and(
        eq(participantAssignments.participantId, participantId),
        eq(participantAssignments.userId, request.userId),
        isNull(participantAssignments.revokedAt),
      ),
    );

  if (existing.some((row) => isAssignmentEffective({ ...row }, new Date()))) {
    throw new HttpError('conflict', 'That person already has access to this participant.');
  }

  const [row] = await db
    .insert(participantAssignments)
    .values({
      participantId,
      userId: request.userId,
      kind: request.kind,
      reason: request.reason ?? null,
      expiresAt,
      grantedBy,
    })
    .returning();

  await db.insert(syncScopeChanges).values({
    userId: request.userId,
    participantId,
    effect: 'granted',
  });

  await recordAudit(db, {
    action: 'assignment.grant',
    actor,
    entityType: 'participant_assignment',
    entityId: row!.id,
    participantId,
    // Ids and shape. The reason is free text a person wrote, so it stays out.
    metadata: {
      userId: request.userId,
      kind: request.kind,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return toAssignment(row!, { displayName: target.displayName, role: target.role }, new Date());
}

export async function findAssignment(db: Database, assignmentId: string): Promise<AssignmentRow> {
  const [row] = await db
    .select()
    .from(participantAssignments)
    .where(eq(participantAssignments.id, assignmentId))
    .limit(1);

  if (!row) throw new HttpError('not_found', 'That assignment does not exist.');
  return row;
}

export async function revokeAssignment(
  db: Database,
  assignmentId: string,
  actor: AuditActor,
): Promise<ParticipantAssignment> {
  const existing = await findAssignment(db, assignmentId);

  if (existing.revokedAt !== null) {
    throw new HttpError('conflict', 'That access has already been revoked.');
  }

  const [row] = await db
    .update(participantAssignments)
    .set({ revokedAt: new Date() })
    .where(eq(participantAssignments.id, assignmentId))
    .returning();

  await db.insert(syncScopeChanges).values({
    userId: existing.userId,
    participantId: existing.participantId,
    effect: 'revoked',
  });

  await recordAudit(db, {
    action: 'assignment.revoke',
    actor,
    entityType: 'participant_assignment',
    entityId: assignmentId,
    participantId: existing.participantId,
    metadata: { userId: existing.userId, kind: existing.kind },
  });

  const [target] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);

  return toAssignment(
    row!,
    { displayName: target?.displayName ?? 'Unknown', role: target?.role ?? 'worker' },
    new Date(),
  );
}
