import { z } from 'zod';
import {
  choicesOf,
  fieldKeySchema,
  findField,
  requiredFieldKeys,
  type TemplateField,
  type TemplateSchema,
} from './templates.js';
import { isIsoDate, isTimeOfDay } from './timezone.js';

/**
 * Recording a check (doc 01 §5.5, doc 03 §6, doc 04 §7).
 *
 * A value arrives in whichever slot suits its type, matching the columns it
 * lands in: numbers stay numeric so trends and compliance are plain SQL (A8),
 * free text is encrypted, and everything else is JSON.
 *
 * Validation lives here rather than only on the server because a worker with no
 * signal has to be told the number is out of range at the moment they type it,
 * not two hours later when the outbox drains.
 */

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** A choice value, a list of them, or a date, time or datetime string. */
const jsonValueSchema = z.union([z.string(), z.array(z.string())]);

export const checkValueSchema = z
  .object({
    fieldKey: fieldKeySchema,
    number: z.number().finite().nullable().optional(),
    bool: z.boolean().nullable().optional(),
    text: z.string().nullable().optional(),
    json: jsonValueSchema.nullable().optional(),
    recordedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export type CheckValue = z.infer<typeof checkValueSchema>;

/** True when the worker has actually answered, as opposed to cleared it. */
export function hasValue(value: CheckValue): boolean {
  if (value.number !== null && value.number !== undefined) return true;
  if (value.bool !== null && value.bool !== undefined) return true;
  if (value.text !== null && value.text !== undefined && value.text.trim() !== '') return true;
  if (value.json !== null && value.json !== undefined) {
    return Array.isArray(value.json) ? value.json.length > 0 : value.json !== '';
  }
  return false;
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * One value against its field definition. Returns the message a worker should
 * see, or null.
 *
 * `min` and `max` reject impossible input. They never mean the value is
 * clinically concerning, and nothing in this function or its callers says so.
 */
export function validateFieldValue(field: TemplateField, value: CheckValue): string | null {
  if (!hasValue(value)) return null;

  switch (field.type) {
    case 'number': {
      if (typeof value.number !== 'number') return `${field.label} takes a number.`;
      if (decimalPlaces(value.number) > field.decimals) {
        return field.decimals === 0
          ? `${field.label} takes a whole number.`
          : `${field.label} takes at most ${field.decimals} decimal places.`;
      }
      if (field.min !== undefined && value.number < field.min) {
        return `${field.label} cannot be below ${field.min}${field.unit}.`;
      }
      if (field.max !== undefined && value.number > field.max) {
        return `${field.label} cannot be above ${field.max}${field.unit}.`;
      }
      return null;
    }

    case 'boolean':
      return typeof value.bool === 'boolean' ? null : `${field.label} takes yes or no.`;

    case 'text': {
      if (typeof value.text !== 'string') return `${field.label} takes text.`;
      if (value.text.length > field.maxLength) {
        return `${field.label} is limited to ${field.maxLength} characters.`;
      }
      return null;
    }

    case 'single_choice': {
      if (typeof value.json !== 'string') return `Choose one option for ${field.label}.`;
      const allowed = choicesOf(field).map((choice) => choice.value);
      return allowed.includes(value.json) ? null : `That is not an option for ${field.label}.`;
    }

    case 'checklist':
    case 'multi_choice': {
      if (!Array.isArray(value.json)) return `${field.label} takes a list of options.`;
      const allowed = new Set(choicesOf(field).map((choice) => choice.value));
      const seen = new Set<string>();
      for (const entry of value.json) {
        if (!allowed.has(entry)) return `That is not an option for ${field.label}.`;
        if (seen.has(entry)) return `${field.label} has the same option twice.`;
        seen.add(entry);
      }
      return null;
    }

    case 'date':
      return typeof value.json === 'string' && isIsoDate(value.json)
        ? null
        : `${field.label} takes a date.`;

    case 'time':
      return typeof value.json === 'string' && isTimeOfDay(value.json)
        ? null
        : `${field.label} takes a time.`;

    case 'datetime':
      return typeof value.json === 'string' && !Number.isNaN(Date.parse(value.json))
        ? null
        : `${field.label} takes a date and time.`;
  }
}

export type ValueProblem = { fieldKey: string; message: string };

/** Every problem at once, so a form reports all of its errors in one pass. */
export function validateValues(
  schema: TemplateSchema,
  values: readonly CheckValue[],
): ValueProblem[] {
  const problems: ValueProblem[] = [];

  for (const value of values) {
    const field = findField(schema, value.fieldKey);
    if (!field) {
      problems.push({
        fieldKey: value.fieldKey,
        message: 'This form no longer has that field.',
      });
      continue;
    }
    const message = validateFieldValue(field, value);
    if (message !== null) problems.push({ fieldKey: value.fieldKey, message });
  }

  return problems;
}

/**
 * Completeness (doc 01 §5.5). Partial entry is expected and allowed: this only
 * answers whether the window can stop asking, never whether it may be saved.
 */
export function missingRequiredKeys(
  schema: TemplateSchema,
  values: readonly CheckValue[],
): string[] {
  const answered = new Set(values.filter(hasValue).map((value) => value.fieldKey));
  return requiredFieldKeys(schema).filter((key) => !answered.has(key));
}

export function isEntryComplete(schema: TemplateSchema, values: readonly CheckValue[]): boolean {
  return missingRequiredKeys(schema, values).length === 0;
}

export const entryStatuses = ['partial', 'complete'] as const;
export const entryStatusSchema = z.enum(entryStatuses);
export type EntryStatus = z.infer<typeof entryStatusSchema>;

/**
 * The upsert (doc 04 §7). `entryId` is generated on the device as a UUID v7, so
 * replaying the same request after a dropout updates the same row rather than
 * creating a second one.
 */
export const putEntryRequestSchema = z
  .object({
    entryId: z.string().uuid(),
    templateVersionId: z.string().uuid(),
    recordedAt: isoDateTimeSchema,
    /** Only the supplied fields are written. Absent is not the same as null. */
    values: z.array(checkValueSchema).max(200),
  })
  .strict();

export type PutEntryRequest = z.infer<typeof putEntryRequestSchema>;

/** An edit after submission. Every change writes a revision row (doc 01 §5.5). */
export const editEntryRequestSchema = z
  .object({
    values: z.array(checkValueSchema).min(1).max(200),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type EditEntryRequest = z.infer<typeof editEntryRequestSchema>;

export const checkValueViewSchema = z.object({
  fieldKey: z.string(),
  number: z.number().nullable(),
  bool: z.boolean().nullable(),
  text: z.string().nullable(),
  json: jsonValueSchema.nullable(),
  unit: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: z.string().nullable(),
});

export type CheckValueView = z.infer<typeof checkValueViewSchema>;

export const checkEntrySchema = z.object({
  id: z.string(),
  windowId: z.string(),
  participantId: z.string(),
  templateVersionId: z.string(),
  recordedBy: z.string().nullable(),
  recordedByName: z.string().nullable(),
  recordedAt: z.string(),
  receivedAt: z.string(),
  status: entryStatusSchema,
  isLate: z.boolean(),
  editedAt: z.string().nullable(),
  editCount: z.number(),
  values: z.array(checkValueViewSchema),
});

export type CheckEntry = z.infer<typeof checkEntrySchema>;

export const entryRevisionSchema = z.object({
  id: z.string(),
  fieldKey: z.string(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  changedBy: z.string().nullable(),
  changedByName: z.string().nullable(),
  changedAt: z.string(),
  reason: z.string().nullable(),
});

export type EntryRevision = z.infer<typeof entryRevisionSchema>;

/**
 * Missed reason codes (doc 03 §6). Admin-configurable, because "forgot" and
 * "participant refused" are the organisation's vocabulary, not ours.
 */
export const missedReasonCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  requiresNote: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number(),
});

export type MissedReasonCode = z.infer<typeof missedReasonCodeSchema>;

export const createMissedReasonCodeRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,40}$/, 'A code uses lower case letters, numbers and underscores.'),
    label: z.string().trim().min(1).max(100),
    requiresNote: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export type CreateMissedReasonCodeRequest = z.infer<typeof createMissedReasonCodeRequestSchema>;

export const updateMissedReasonCodeRequestSchema = createMissedReasonCodeRequestSchema
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateMissedReasonCodeRequest = z.infer<typeof updateMissedReasonCodeRequestSchema>;

export const putMissReasonRequestSchema = z
  .object({
    /** Device-generated so an offline capture keeps its identity. */
    id: z.string().uuid().optional(),
    reasonCodeId: z.string().uuid(),
    note: z.string().trim().max(2000).nullable().optional(),
    recordedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export type PutMissReasonRequest = z.infer<typeof putMissReasonRequestSchema>;

export const missReasonSchema = z.object({
  id: z.string(),
  windowId: z.string(),
  reasonCodeId: z.string(),
  code: z.string(),
  label: z.string(),
  note: z.string().nullable(),
  recordedBy: z.string().nullable(),
  recordedByName: z.string().nullable(),
  recordedAt: z.string(),
});

export type MissReason = z.infer<typeof missReasonSchema>;

/** A note is required when the chosen code says so, and "other" always does. */
export function missReasonProblem(
  code: Pick<MissedReasonCode, 'requiresNote' | 'label'>,
  note: string | null | undefined,
): string | null {
  if (!code.requiresNote) return null;
  return note !== null && note !== undefined && note.trim() !== ''
    ? null
    : `"${code.label}" needs a short note.`;
}
