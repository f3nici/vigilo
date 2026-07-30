import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  canCloseIncident,
  canEditOthersIncidents,
  canTransitionTo,
  describeIncidentStatus,
  outstandingActions,
  roleCanSeeEntity,
  zonedTimeToUtc,
  type CloseIncidentRequest,
  type CompleteIncidentActionRequest,
  type CreateIncidentActionRequest,
  type CreateIncidentRequest,
  type Incident,
  type IncidentAction,
  type IncidentQuery,
  type IncidentStatus,
  type ReopenIncidentRequest,
  type Role,
  type UpdateIncidentRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  incidentActions,
  incidents,
  users,
  type IncidentActionRow,
  type IncidentRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptField, decryptOptional, encryptField, encryptOptional } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Incidents (doc 01 §7.3, doc 03 §9, doc 04 §10).
 *
 * A structured record separate from the diary. Any staff role raises one; only
 * a team leader, nurse or admin closes one. **A participant self-access account
 * never sees one**, and that is refused here rather than only hidden in the UI,
 * so a hand-written request cannot walk around the screen that omits it.
 *
 * Nothing is deleted. The app database role has no DELETE on either table, and
 * an action added by mistake is completed with a note saying so, which leaves a
 * record rather than a hole.
 *
 * The NDIS Commission reportable-incident workflow, the 24-hour and 5-day
 * notification tracking and the restrictive practice register are out of scope
 * (doc 01 §7.3). The organisation handles those outside Vigilo.
 */

export const COLUMN = {
  summary: 'incidents.summary_enc',
  detail: 'incidents.detail_enc',
  immediateAction: 'incidents.immediate_action_enc',
  injuries: 'incidents.injuries_enc',
  involved: 'incidents.involved_enc',
  closureNotes: 'incidents.closure_notes_enc',
  action: 'incident_actions.action_enc',
  actionNote: 'incident_actions.note_enc',
} as const;

export type IncidentPrincipal = {
  userId: string;
  role: Role;
};

/**
 * The rule doc 03 §9 states in bold: never visible to a participant account.
 *
 * Called at the top of every function here, including the read paths, because
 * the scope resolver answers "may you touch this participant" and this answers
 * a different question entirely.
 */
function assertMaySeeIncidents(role: Role): void {
  if (!roleCanSeeEntity(role, 'incident')) {
    throw new HttpError('scope_denied', 'Incidents are not part of your record.');
  }
}

/* ------------------------------------------------------------------ reading */

const assignees = alias(users, 'assignee');
const completers = alias(users, 'completer');

function toAction(
  keyRing: KeyRing,
  row: IncidentActionRow,
  assignedToName: string | null,
  completedByName: string | null,
): IncidentAction {
  return {
    id: row.id,
    incidentId: row.incidentId,
    action: decryptField(keyRing, COLUMN.action, row.actionEnc),
    assignedTo: row.assignedTo,
    assignedToName,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedBy: row.completedBy,
    completedByName,
    note: decryptOptional(keyRing, COLUMN.actionNote, row.noteEnc),
    createdAt: row.createdAt.toISOString(),
  };
}

async function actionsFor(
  db: Database,
  keyRing: KeyRing,
  incidentIds: readonly string[],
): Promise<Map<string, IncidentAction[]>> {
  const byIncident = new Map<string, IncidentAction[]>();
  if (incidentIds.length === 0) return byIncident;

  const rows = await db
    .select({
      action: incidentActions,
      assignedToName: assignees.displayName,
      completedByName: completers.displayName,
    })
    .from(incidentActions)
    .leftJoin(assignees, eq(assignees.id, incidentActions.assignedTo))
    .leftJoin(completers, eq(completers.id, incidentActions.completedBy))
    .where(inArray(incidentActions.incidentId, [...incidentIds]))
    .orderBy(asc(incidentActions.createdAt));

  for (const row of rows) {
    const bucket = byIncident.get(row.action.incidentId) ?? [];
    bucket.push(toAction(keyRing, row.action, row.assignedToName, row.completedByName));
    byIncident.set(row.action.incidentId, bucket);
  }

  return byIncident;
}

const reporters = alias(users, 'reporter');
const closers = alias(users, 'closer');

async function toIncidents(
  db: Database,
  keyRing: KeyRing,
  rows: readonly {
    incident: IncidentRow;
    reportedByName: string | null;
    closedByName: string | null;
  }[],
): Promise<Incident[]> {
  const actions = await actionsFor(
    db,
    keyRing,
    rows.map((row) => row.incident.id),
  );

  return rows.map(({ incident, reportedByName, closedByName }) => ({
    id: incident.id,
    participantId: incident.participantId,
    occurredAt: incident.occurredAt.toISOString(),
    discoveredAt: incident.discoveredAt.toISOString(),
    severity: incident.severity,
    status: incident.status,
    summary: decryptField(keyRing, COLUMN.summary, incident.summaryEnc),
    detail: decryptField(keyRing, COLUMN.detail, incident.detailEnc),
    immediateAction: decryptField(keyRing, COLUMN.immediateAction, incident.immediateActionEnc),
    injuries: decryptOptional(keyRing, COLUMN.injuries, incident.injuriesEnc),
    involved: decryptOptional(keyRing, COLUMN.involved, incident.involvedEnc),
    familyNotifiedAt: incident.familyNotifiedAt?.toISOString() ?? null,
    reportedBy: incident.reportedBy,
    reportedByName,
    closedBy: incident.closedBy,
    closedByName,
    closedAt: incident.closedAt?.toISOString() ?? null,
    closureNotes: decryptOptional(keyRing, COLUMN.closureNotes, incident.closureNotesEnc),
    actions: actions.get(incident.id) ?? [],
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  }));
}

async function load(
  db: Database,
  keyRing: KeyRing,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<Incident[]> {
  const rows = await db
    .select({
      incident: incidents,
      reportedByName: reporters.displayName,
      closedByName: closers.displayName,
    })
    .from(incidents)
    .leftJoin(reporters, eq(reporters.id, incidents.reportedBy))
    .leftJoin(closers, eq(closers.id, incidents.closedBy))
    .where(where)
    .orderBy(desc(incidents.occurredAt))
    .limit(limit);

  return toIncidents(db, keyRing, rows);
}

export async function listIncidents(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  query: IncidentQuery,
  principal: IncidentPrincipal,
  timeZone: string,
): Promise<Incident[]> {
  assertMaySeeIncidents(principal.role);

  const filters = [eq(incidents.participantId, participantId)];
  if (query.status !== undefined) filters.push(eq(incidents.status, query.status));
  if (query.severity !== undefined) filters.push(eq(incidents.severity, query.severity));
  if (query.from !== undefined) {
    filters.push(gte(incidents.occurredAt, zonedTimeToUtc(query.from, 0, timeZone)));
  }
  if (query.to !== undefined) {
    filters.push(lt(incidents.occurredAt, zonedTimeToUtc(query.to, 24 * 60, timeZone)));
  }

  return load(db, keyRing, and(...filters), query.limit);
}

/** Everything the caller can see, newest first. The admin dashboard runs on it. */
export async function recentIncidents(
  db: Database,
  keyRing: KeyRing,
  participantIds: readonly string[] | 'all',
  principal: IncidentPrincipal,
  limit = 20,
): Promise<Incident[]> {
  assertMaySeeIncidents(principal.role);

  if (participantIds !== 'all') {
    if (participantIds.length === 0) return [];
    return load(db, keyRing, and(inArray(incidents.participantId, [...participantIds])), limit);
  }

  return load(db, keyRing, undefined, limit);
}

export async function findIncidentRow(db: Database, id: string): Promise<IncidentRow> {
  const [row] = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That incident does not exist.');
  return row;
}

export async function getIncident(
  db: Database,
  keyRing: KeyRing,
  id: string,
  principal: IncidentPrincipal,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);
  const found = await load(db, keyRing, and(eq(incidents.id, id)), 1);
  const incident = found[0];
  if (!incident) throw new HttpError('not_found', 'That incident does not exist.');
  return incident;
}

/* ------------------------------------------------------------------ writing */

export async function createIncident(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateIncidentRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);

  const [existing] = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, request.id))
    .limit(1);

  // Idempotent by the device-generated id, like every other record a device
  // creates: a retried submission must not raise a second incident.
  if (!existing) {
    await db.insert(incidents).values({
      id: request.id,
      participantId,
      occurredAt: new Date(request.occurredAt),
      discoveredAt: new Date(request.discoveredAt),
      reportedBy: principal.userId,
      severity: request.severity,
      summaryEnc: encryptField(keyRing, COLUMN.summary, request.summary),
      detailEnc: encryptField(keyRing, COLUMN.detail, request.detail),
      immediateActionEnc: encryptField(keyRing, COLUMN.immediateAction, request.immediateAction),
      injuriesEnc: encryptOptional(keyRing, COLUMN.injuries, request.injuries),
      involvedEnc: encryptOptional(keyRing, COLUMN.involved, request.involved),
      familyNotifiedAt:
        request.familyNotifiedAt === null ? null : new Date(request.familyNotifiedAt),
    });

    await recordAudit(db, {
      action: 'incident.create',
      actor,
      entityType: 'incident',
      entityId: request.id,
      participantId,
      // Severity and the timing gap, never the narrative.
      metadata: {
        severity: request.severity,
        discoveryDelayMinutes: Math.round(
          (Date.parse(request.discoveredAt) - Date.parse(request.occurredAt)) / 60_000,
        ),
        familyNotified: request.familyNotifiedAt !== null,
      },
    });
  }

  return getIncident(db, keyRing, request.id, principal);
}

export async function updateIncident(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: UpdateIncidentRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);
  const existing = await findIncidentRow(db, id);

  if (existing.reportedBy !== principal.userId && !canEditOthersIncidents(principal.role)) {
    throw new HttpError(
      'scope_denied',
      "Only a team leader, nurse or admin can change someone else's incident.",
    );
  }

  if (request.status !== undefined && request.status !== existing.status) {
    if (!canTransitionTo(existing.status, request.status)) {
      throw new HttpError('conflict', 'That incident cannot move to that status from where it is.');
    }
    // Coming back from closed is a reopen, and a reopen states a reason.
    if (existing.status === 'closed') {
      throw new HttpError('conflict', 'Reopen it instead, which records why it was reopened.');
    }
  }

  const occurredAt = request.occurredAt ?? existing.occurredAt.toISOString();
  const discoveredAt = request.discoveredAt ?? existing.discoveredAt.toISOString();
  if (Date.parse(discoveredAt) < Date.parse(occurredAt)) {
    throw new HttpError('validation_failed', 'It cannot have been discovered before it happened.');
  }

  const patch: Partial<typeof incidents.$inferInsert> = { updatedAt: new Date() };
  if (request.occurredAt !== undefined) patch.occurredAt = new Date(request.occurredAt);
  if (request.discoveredAt !== undefined) patch.discoveredAt = new Date(request.discoveredAt);
  if (request.severity !== undefined) patch.severity = request.severity;
  if (request.status !== undefined) patch.status = request.status;
  if (request.summary !== undefined) {
    patch.summaryEnc = encryptField(keyRing, COLUMN.summary, request.summary);
  }
  if (request.detail !== undefined) {
    patch.detailEnc = encryptField(keyRing, COLUMN.detail, request.detail);
  }
  if (request.immediateAction !== undefined) {
    patch.immediateActionEnc = encryptField(
      keyRing,
      COLUMN.immediateAction,
      request.immediateAction,
    );
  }
  if (request.injuries !== undefined) {
    patch.injuriesEnc = encryptOptional(keyRing, COLUMN.injuries, request.injuries);
  }
  if (request.involved !== undefined) {
    patch.involvedEnc = encryptOptional(keyRing, COLUMN.involved, request.involved);
  }
  if (request.familyNotifiedAt !== undefined) {
    patch.familyNotifiedAt =
      request.familyNotifiedAt === null ? null : new Date(request.familyNotifiedAt);
  }

  await db.update(incidents).set(patch).where(eq(incidents.id, id));

  await recordAudit(db, {
    action: 'incident.update',
    actor,
    entityType: 'incident',
    entityId: id,
    participantId: existing.participantId,
    metadata: {
      fields: Object.keys(request).sort(),
      editedAnothersIncident: existing.reportedBy !== principal.userId,
    },
  });

  return getIncident(db, keyRing, id, principal);
}

/**
 * Closing (doc 01 §7.3). Team leader, nurse or admin only.
 *
 * Actions still outstanding do not block it: an action due next month is not a
 * reason to keep a review open. The count is returned and appears on the PDF,
 * so closing never hides that something is still owed.
 */
export async function closeIncident(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: CloseIncidentRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<{ incident: Incident; actionsOutstanding: number }> {
  assertMaySeeIncidents(principal.role);

  if (!canCloseIncident(principal.role)) {
    throw new HttpError(
      'scope_denied',
      'Only a team leader, nurse or admin can close an incident.',
    );
  }

  const existing = await findIncidentRow(db, id);
  if (existing.status === 'closed') {
    throw new HttpError('conflict', 'That incident is already closed.');
  }

  const now = new Date();
  await db
    .update(incidents)
    .set({
      status: 'closed',
      closedAt: now,
      closedBy: principal.userId,
      closureNotesEnc: encryptField(keyRing, COLUMN.closureNotes, request.closureNotes),
      updatedAt: now,
    })
    .where(eq(incidents.id, id));

  const incident = await getIncident(db, keyRing, id, principal);
  const still = outstandingActions(incident.actions);

  await recordAudit(db, {
    action: 'incident.close',
    actor,
    entityType: 'incident',
    entityId: id,
    participantId: existing.participantId,
    metadata: { fromStatus: existing.status, actionsOutstanding: still },
  });

  return { incident, actionsOutstanding: still };
}

/** Reopening, with a reason. Something closed in March can matter in April. */
export async function reopenIncident(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: ReopenIncidentRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);

  if (!canCloseIncident(principal.role)) {
    throw new HttpError(
      'scope_denied',
      'Only a team leader, nurse or admin can reopen an incident.',
    );
  }

  const existing = await findIncidentRow(db, id);
  if (existing.status !== 'closed') {
    throw new HttpError('conflict', 'That incident is not closed.');
  }

  const status: IncidentStatus = request.status;
  await db
    .update(incidents)
    .set({ status, closedAt: null, closedBy: null, updatedAt: new Date() })
    .where(eq(incidents.id, id));

  await recordAudit(db, {
    action: 'incident.reopen',
    actor,
    entityType: 'incident',
    entityId: id,
    participantId: existing.participantId,
    // The reason is kept in the audit log rather than on the incident, because
    // it is a statement about the review rather than about what happened.
    metadata: { toStatus: status, reason: request.reason },
  });

  return getIncident(db, keyRing, id, principal);
}

/* ------------------------------------------------------------------ actions */

export async function addAction(
  db: Database,
  keyRing: KeyRing,
  incidentId: string,
  request: CreateIncidentActionRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);
  const incident = await findIncidentRow(db, incidentId);

  if (request.assignedTo !== null) {
    const [assignee] = await db
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, request.assignedTo))
      .limit(1);
    if (!assignee || assignee.status !== 'active' || !roleCanSeeEntity(assignee.role, 'incident')) {
      throw new HttpError(
        'validation_failed',
        'That person cannot be given a follow-up action on an incident.',
      );
    }
  }

  await db
    .insert(incidentActions)
    .values({
      id: request.id,
      incidentId,
      actionEnc: encryptField(keyRing, COLUMN.action, request.action),
      assignedTo: request.assignedTo,
      dueAt: request.dueAt === null ? null : new Date(request.dueAt),
    })
    .onConflictDoNothing();

  await recordAudit(db, {
    action: 'incident.action_add',
    actor,
    entityType: 'incident',
    entityId: incidentId,
    participantId: incident.participantId,
    metadata: { actionId: request.id, assigned: request.assignedTo !== null },
  });

  return getIncident(db, keyRing, incidentId, principal);
}

export async function completeAction(
  db: Database,
  keyRing: KeyRing,
  actionId: string,
  request: CompleteIncidentActionRequest,
  principal: IncidentPrincipal,
  actor: AuditActor,
): Promise<Incident> {
  assertMaySeeIncidents(principal.role);

  const [action] = await db
    .select()
    .from(incidentActions)
    .where(eq(incidentActions.id, actionId))
    .limit(1);
  if (!action) throw new HttpError('not_found', 'That follow-up action does not exist.');

  const incident = await findIncidentRow(db, action.incidentId);

  if (action.completedAt !== null) {
    throw new HttpError('conflict', 'That action is already done.');
  }

  await db
    .update(incidentActions)
    .set({
      completedAt: new Date(),
      completedBy: principal.userId,
      noteEnc: encryptOptional(keyRing, COLUMN.actionNote, request.note),
      updatedAt: new Date(),
    })
    .where(eq(incidentActions.id, actionId));

  await recordAudit(db, {
    action: 'incident.action_complete',
    actor,
    entityType: 'incident',
    entityId: action.incidentId,
    participantId: incident.participantId,
    metadata: { actionId, hasNote: (request.note ?? '').trim() !== '' },
  });

  return getIncident(db, keyRing, action.incidentId, principal);
}

/** For the PDF footer and the list header, in the words a reader uses. */
export function incidentHeadline(incident: Incident): string {
  return `${describeIncidentStatus(incident.status)} · ${incident.summary}`;
}
