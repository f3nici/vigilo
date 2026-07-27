import { z } from 'zod';
import { assignmentKindSchema } from './access.js';
import { roleSchema } from './roles.js';

/**
 * Participant contracts (doc 01 §4, doc 03 §3, doc 04 §3).
 *
 * Every name and contact detail is encrypted at rest, so the wire shape here is
 * the only place the plaintext is described. The client validates before
 * sending and the server validates again on receipt.
 */

export const participantStatuses = ['active', 'archived'] as const;
export const participantStatusSchema = z.enum(participantStatuses);
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

/**
 * An NDIS number is nine digits. People write it with spaces or hyphens, so
 * normalise before storing: the blind index is an exact match and only agrees
 * with itself if both sides normalise the same way.
 */
export function normaliseNdisNumber(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export const ndisNumberSchema = z
  .string()
  .trim()
  .transform(normaliseNdisNumber)
  .pipe(z.string().regex(/^\d{9}$/, 'An NDIS number is nine digits.'));

const nameSchema = z.string().trim().min(1).max(100);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Plain `YYYY-MM-DD`, and a date that actually exists. */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker, or type it as YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'That date does not exist.');

export const createParticipantRequestSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  preferredName: optionalText(100),
  dateOfBirth: isoDateSchema,
  ndisNumber: ndisNumberSchema,
  address: optionalText(500),
  phone: optionalText(50),
  email: optionalText(320),
  /** General admin notes. Never clinical: that is what the diary is for. */
  notes: optionalText(4000),
});

export type CreateParticipantRequest = z.infer<typeof createParticipantRequestSchema>;

export const updateParticipantRequestSchema = createParticipantRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateParticipantRequest = z.infer<typeof updateParticipantRequestSchema>;

/**
 * How the caller reaches this participant. An admin sees everyone, so their
 * access has no expiry; a worker holding a temporary grant needs to see that it
 * runs out and when (doc 06 §4.1).
 */
export const participantAccessSchema = z.object({
  kind: z.enum(['all', 'standing', 'temporary', 'team', 'self']),
  expiresAt: z.string().nullable(),
});

export type ParticipantAccess = z.infer<typeof participantAccessSchema>;

/** What the list needs. Names are decrypted per row, which is fine at 200. */
export const participantSummarySchema = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  status: participantStatusSchema,
  archivedAt: z.string().nullable(),
  access: participantAccessSchema,
});

export type ParticipantSummary = z.infer<typeof participantSummarySchema>;

export const alertKinds = ['allergy', 'medical', 'behavioural', 'communication', 'other'] as const;
export const alertKindSchema = z.enum(alertKinds);
export type AlertKind = z.infer<typeof alertKindSchema>;

/**
 * Severity drives the colour of the flag, and nothing else. It describes how
 * urgently a human should read the alert, never a judgement about a recorded
 * value (CLAUDE.md).
 */
export const alertSeverities = ['info', 'warning', 'critical'] as const;
export const alertSeveritySchema = z.enum(alertSeverities);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertSchema = z.object({
  id: z.string().uuid(),
  participantId: z.string().uuid(),
  kind: alertKindSchema,
  severity: alertSeveritySchema,
  text: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ParticipantAlert = z.infer<typeof alertSchema>;

export const createAlertRequestSchema = z.object({
  kind: alertKindSchema,
  severity: alertSeveritySchema,
  text: z.string().trim().min(1).max(500),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
});

export type CreateAlertRequest = z.infer<typeof createAlertRequestSchema>;

export const updateAlertRequestSchema = createAlertRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateAlertRequest = z.infer<typeof updateAlertRequestSchema>;

export const emergencyContactSchema = z.object({
  id: z.string().uuid(),
  participantId: z.string().uuid(),
  name: z.string(),
  relationship: z.string(),
  phonePrimary: z.string(),
  phoneSecondary: z.string().nullable(),
  email: z.string().nullable(),
  isPrimary: z.boolean(),
  sortOrder: z.number().int(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EmergencyContact = z.infer<typeof emergencyContactSchema>;

export const createContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(1).max(100),
  phonePrimary: z.string().trim().min(1).max(50),
  phoneSecondary: optionalText(50),
  email: optionalText(320),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  notes: optionalText(1000),
});

export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

export const updateContactRequestSchema = createContactRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

/** One per participant. Must be readable offline at all times (doc 03 §3). */
export const emergencyPlanSchema = z.object({
  participantId: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().uuid().nullable(),
});

export type EmergencyPlan = z.infer<typeof emergencyPlanSchema>;

export const putEmergencyPlanRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
});

export type PutEmergencyPlanRequest = z.infer<typeof putEmergencyPlanRequestSchema>;

/** The full record behind a participant's overview screen (doc 04 §3). */
export const participantDetailSchema = participantSummarySchema.extend({
  dateOfBirth: z.string(),
  ndisNumber: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  alerts: z.array(alertSchema),
  contacts: z.array(emergencyContactSchema),
  emergencyPlan: emergencyPlanSchema.nullable(),
});

export type ParticipantDetail = z.infer<typeof participantDetailSchema>;

export const assignmentSchema = z.object({
  id: z.string().uuid(),
  participantId: z.string().uuid(),
  userId: z.string().uuid(),
  userDisplayName: z.string(),
  userRole: roleSchema,
  kind: assignmentKindSchema,
  reason: z.string().nullable(),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  /** Not revoked and not expired: the same rule the scope resolver applies. */
  effective: z.boolean(),
});

export type ParticipantAssignment = z.infer<typeof assignmentSchema>;

export const createAssignmentRequestSchema = z
  .object({
    userId: z.string().uuid(),
    kind: assignmentKindSchema,
    /** Required on a temporary grant, rejected on a standing one. */
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .refine(
    (value) => (value.kind === 'temporary') === Boolean(value.expiresAt && value.reason),
    'A temporary grant needs both an expiry and a reason, and a standing one takes neither.',
  );

export type CreateAssignmentRequest = z.infer<typeof createAssignmentRequestSchema>;

/**
 * What staff call this person. The preferred name wins wherever there is room
 * for one name only, because that is the name they answer to.
 */
export function participantDisplayName(participant: {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
}): string {
  const given = participant.preferredName?.trim() || participant.firstName;
  return `${given} ${participant.lastName}`.trim();
}

/**
 * The most a notification may carry (doc 01 §9). Nothing else about a
 * participant is allowed onto a lock screen.
 */
export function participantShortName(participant: { firstName: string; lastName: string }): string {
  return `${participant.firstName.trim().charAt(0).toUpperCase()}. ${participant.lastName}`;
}

/** Surname then first name, so a list reads the way a staff member expects. */
export function compareParticipants(a: ParticipantSummary, b: ParticipantSummary): number {
  const surnames = a.lastName.localeCompare(b.lastName, 'en-AU', { sensitivity: 'base' });
  if (surnames !== 0) return surnames;
  return a.firstName.localeCompare(b.firstName, 'en-AU', { sensitivity: 'base' });
}

/**
 * Client-side filtering of the already-decrypted list. Deliberately not a
 * server-side free-text search: the names are encrypted, and searching them in
 * SQL would mean decrypting the whole table on every keystroke (doc 03 §3).
 */
export function matchesParticipantSearch(
  participant: Pick<ParticipantSummary, 'firstName' | 'lastName' | 'preferredName'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [participant.firstName, participant.lastName, participant.preferredName]
    .filter((part): part is string => typeof part === 'string')
    .some((part) => part.toLowerCase().includes(needle));
}
