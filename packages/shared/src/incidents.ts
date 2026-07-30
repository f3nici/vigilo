import { z } from 'zod';
import type { Role } from './roles.js';

/**
 * Incidents (doc 01 §7.3, doc 03 §9).
 *
 * A structured record separate from the diary, raisable by any staff role,
 * closed only by a team leader, nurse or admin. Never visible to a participant
 * self-access account, which is enforced in the scope layer rather than only in
 * the UI (`roleCanSeeEntity` in access.ts).
 *
 * The NDIS Commission reportable-incident fields, the 24-hour and 5-day
 * notification tracking and the restrictive practice register are explicitly
 * out of scope (doc 01 §7.3). The organisation handles those outside Vigilo,
 * and half-implementing a statutory workflow is worse than not having it.
 *
 * Severity is a fact the reporter states about what happened. It is not a
 * clinical judgement about a person and nothing keys a colour or an alert off a
 * recorded value (CLAUDE.md).
 */

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const incidentSeverities = ['low', 'moderate', 'high'] as const;
export const incidentSeveritySchema = z.enum(incidentSeverities);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const incidentStatuses = ['open', 'under_review', 'closed'] as const;
export const incidentStatusSchema = z.enum(incidentStatuses);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

/* ------------------------------------------------------------- workflow */

/**
 * Open to under review to closed, and back from either (doc 01 §7.3).
 *
 * Reopening a closed incident is allowed: something closed in March can turn
 * out to matter in April, and the alternative is a second incident record
 * about the same event, which is worse for anybody reading the history. Every
 * transition is audited.
 */
const transitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['under_review', 'closed'],
  under_review: ['open', 'closed'],
  closed: ['under_review', 'open'],
};

export function canTransitionTo(from: IncidentStatus, to: IncidentStatus): boolean {
  return transitions[from].includes(to);
}

/** Only a team leader, nurse or admin closes one (doc 01 §3.6). */
export function canCloseIncident(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

/** Any staff role raises one. The person who was there is the person who saw it. */
export function canRaiseIncident(role: Role): boolean {
  return role !== 'participant';
}

/**
 * Editing somebody else's incident narrative needs oversight, exactly as with a
 * check entry or a diary entry. The reporter can always correct their own.
 */
export function canEditOthersIncidents(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

export function describeIncidentStatus(status: IncidentStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'under_review':
      return 'Under review';
    case 'closed':
      return 'Closed';
  }
}

export function describeSeverity(severity: IncidentSeverity): string {
  switch (severity) {
    case 'low':
      return 'Low';
    case 'moderate':
      return 'Moderate';
    case 'high':
      return 'High';
  }
}

/* ------------------------------------------------------------- requests */

const narrative = (max: number) => z.string().trim().max(max);

export const createIncidentRequestSchema = z
  .object({
    /** Device-generated, so an incident has stable identity before it lands. */
    id: z.string().uuid(),
    occurredAt: isoDateTimeSchema,
    /**
     * When somebody found out, which is not when it happened (doc 01 §7.3).
     * The gap between the two is often the most important thing on the record.
     */
    discoveredAt: isoDateTimeSchema,
    severity: incidentSeveritySchema,
    summary: z.string().trim().min(1).max(300),
    detail: z.string().trim().min(1).max(10_000),
    immediateAction: narrative(10_000).min(1),
    injuries: narrative(5_000).nullable().default(null),
    /** Free text, because "who was involved" includes people with no account. */
    involved: narrative(1_000).nullable().default(null),
    familyNotifiedAt: isoDateTimeSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.discoveredAt) >= Date.parse(value.occurredAt),
    'It cannot have been discovered before it happened.',
  );

export type CreateIncidentRequest = z.infer<typeof createIncidentRequestSchema>;

export const updateIncidentRequestSchema = z
  .object({
    occurredAt: isoDateTimeSchema.optional(),
    discoveredAt: isoDateTimeSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    summary: z.string().trim().min(1).max(300).optional(),
    detail: z.string().trim().min(1).max(10_000).optional(),
    immediateAction: narrative(10_000).min(1).optional(),
    injuries: narrative(5_000).nullable().optional(),
    involved: narrative(1_000).nullable().optional(),
    familyNotifiedAt: isoDateTimeSchema.nullable().optional(),
    status: z.enum(['open', 'under_review']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateIncidentRequest = z.infer<typeof updateIncidentRequestSchema>;

/**
 * Closing takes notes, and they are required.
 *
 * Doc 03 §9 has the column nullable, and it stays nullable for rows that
 * predate this. But closing is the moment somebody says the review is finished,
 * and a closure nobody can read the reasoning for is a closure nobody can
 * review (D65).
 */
export const closeIncidentRequestSchema = z
  .object({ closureNotes: z.string().trim().min(1).max(10_000) })
  .strict();

export type CloseIncidentRequest = z.infer<typeof closeIncidentRequestSchema>;

export const reopenIncidentRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(300),
    status: z.enum(['open', 'under_review']).default('under_review'),
  })
  .strict();

export type ReopenIncidentRequest = z.infer<typeof reopenIncidentRequestSchema>;

export const createIncidentActionRequestSchema = z
  .object({
    id: z.string().uuid(),
    action: z.string().trim().min(1).max(2_000),
    assignedTo: z.string().uuid().nullable().default(null),
    dueAt: isoDateTimeSchema.nullable().default(null),
  })
  .strict();

export type CreateIncidentActionRequest = z.infer<typeof createIncidentActionRequestSchema>;

export const completeIncidentActionRequestSchema = z
  .object({ note: z.string().trim().max(2_000).nullable().default(null) })
  .strict();

export type CompleteIncidentActionRequest = z.infer<typeof completeIncidentActionRequestSchema>;

/* ----------------------------------------------------------------- views */

export const incidentActionSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  action: z.string(),
  assignedTo: z.string().nullable(),
  assignedToName: z.string().nullable(),
  dueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
  completedByName: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export type IncidentAction = z.infer<typeof incidentActionSchema>;

export const incidentSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  occurredAt: z.string(),
  discoveredAt: z.string(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  summary: z.string(),
  detail: z.string(),
  immediateAction: z.string(),
  injuries: z.string().nullable(),
  involved: z.string().nullable(),
  familyNotifiedAt: z.string().nullable(),
  reportedBy: z.string().nullable(),
  reportedByName: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  closureNotes: z.string().nullable(),
  actions: z.array(incidentActionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Incident = z.infer<typeof incidentSchema>;

export const incidentQuerySchema = z
  .object({
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    from: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine(
    (value) => value.from === undefined || value.to === undefined || value.from <= value.to,
    'The start date is after the end date.',
  );

export type IncidentQuery = z.infer<typeof incidentQuerySchema>;

/**
 * Actions still outstanding.
 *
 * An incident can be closed with actions outstanding, because an action due
 * next month is not a reason to keep a review open. The count travels with the
 * incident and appears on the PDF, so closing one never hides the fact that
 * something is still owed.
 */
export function outstandingActions(actions: readonly IncidentAction[]): number {
  return actions.filter((action) => action.completedAt === null).length;
}

export function actionIsOverdue(action: IncidentAction, now: Date): boolean {
  if (action.completedAt !== null || action.dueAt === null) return false;
  return Date.parse(action.dueAt) < now.getTime();
}

/** Newest first, and anything still open above anything closed. */
export function incidentSortRank(incident: { status: IncidentStatus }): number {
  if (incident.status === 'open') return 0;
  if (incident.status === 'under_review') return 1;
  return 2;
}
