import { z } from 'zod';

/**
 * Check templates and their frozen version schemas (doc 01 §5.2, doc 03 §4).
 *
 * A template version's `schema` is the contract between the admin who built the
 * form, the device that renders it and the row that stores the answer. It lives
 * here because all three have to read it identically.
 *
 * **There is no range, threshold or alerting config on a field, and there never
 * will be** (D14). The field objects below are `.strict()`, so a key nobody
 * defined here cannot appear in a published schema at all. That is the
 * enforcement, not a convention: an admin cannot add `normalRange` by editing
 * JSON, and a later contributor cannot add one without deleting this comment.
 */

/** Keys are stable identifiers, immutable once published. */
export const fieldKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,62}$/,
    'A field key starts with a letter and uses lower case letters, numbers and underscores.',
  );

export const fieldLabelSchema = z.string().trim().min(1).max(100);
const helpSchema = z.string().trim().max(300);

export const choiceSchema = z
  .object({
    value: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'An option value uses lower case letters and numbers.'),
    label: fieldLabelSchema,
  })
  .strict();

export type Choice = z.infer<typeof choiceSchema>;

const baseField = {
  key: fieldKeySchema,
  label: fieldLabelSchema,
  help: helpSchema.optional(),
  required: z.boolean().default(false),
  sort: z.number().int().min(0).max(10_000),
};

/**
 * `min` and `max` are input sanity bounds, nothing more (doc 01 §5.2). They
 * stop a slipped decimal point reaching the record. They do not colour a value,
 * do not flag one, and are never shown as "normal".
 */
const numberField = z
  .object({
    ...baseField,
    type: z.literal('number'),
    unit: z.string().trim().min(1).max(20),
    decimals: z.number().int().min(0).max(4).default(0),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const booleanField = z.object({ ...baseField, type: z.literal('boolean') }).strict();

const checklistField = z
  .object({ ...baseField, type: z.literal('checklist'), items: z.array(choiceSchema).min(1) })
  .strict();

const singleChoiceField = z
  .object({ ...baseField, type: z.literal('single_choice'), options: z.array(choiceSchema).min(1) })
  .strict();

const multiChoiceField = z
  .object({ ...baseField, type: z.literal('multi_choice'), options: z.array(choiceSchema).min(1) })
  .strict();

const textField = z
  .object({
    ...baseField,
    type: z.literal('text'),
    multiline: z.boolean().default(false),
    maxLength: z.number().int().min(1).max(10_000).default(2000),
  })
  .strict();

const dateField = z.object({ ...baseField, type: z.literal('date') }).strict();
const timeField = z.object({ ...baseField, type: z.literal('time') }).strict();
const dateTimeField = z.object({ ...baseField, type: z.literal('datetime') }).strict();

export const templateFieldSchema = z.discriminatedUnion('type', [
  numberField,
  booleanField,
  checklistField,
  singleChoiceField,
  multiChoiceField,
  textField,
  dateField,
  timeField,
  dateTimeField,
]);

export type TemplateField = z.infer<typeof templateFieldSchema>;
export type FieldType = TemplateField['type'];

export const fieldTypes = [
  'number',
  'boolean',
  'checklist',
  'single_choice',
  'multi_choice',
  'text',
  'date',
  'time',
  'datetime',
] as const;

export const templateSchemaSchema = z.object({ fields: z.array(templateFieldSchema) }).strict();

export type TemplateSchema = z.infer<typeof templateSchemaSchema>;

/** Fields in the order a worker sees them. `sort` first, then key for ties. */
export function orderedFields(schema: TemplateSchema): TemplateField[] {
  return [...schema.fields].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

export function requiredFieldKeys(schema: TemplateSchema): string[] {
  return orderedFields(schema)
    .filter((field) => field.required)
    .map((field) => field.key);
}

export function findField(schema: TemplateSchema, key: string): TemplateField | undefined {
  return schema.fields.find((field) => field.key === key);
}

export function choicesOf(field: TemplateField): Choice[] {
  if (field.type === 'checklist') return field.items;
  if (field.type === 'single_choice' || field.type === 'multi_choice') return field.options;
  return [];
}

/**
 * Publish validation (doc 04 §5).
 *
 * Returns every problem rather than the first, because an admin fixing a form
 * should see the whole list once instead of discovering it one save at a time.
 */
export type SchemaProblem = { field: string | null; message: string };

export function validateTemplateSchema(schema: TemplateSchema): SchemaProblem[] {
  const problems: SchemaProblem[] = [];

  if (schema.fields.length === 0) {
    problems.push({ field: null, message: 'A template needs at least one field.' });
  }

  const seen = new Set<string>();
  for (const field of schema.fields) {
    if (seen.has(field.key)) {
      problems.push({ field: field.key, message: 'Two fields share this key.' });
    }
    seen.add(field.key);

    const choices = choicesOf(field);
    if (choices.length > 0) {
      const values = new Set<string>();
      for (const choice of choices) {
        if (values.has(choice.value)) {
          problems.push({
            field: field.key,
            message: `Two options share the value "${choice.value}".`,
          });
        }
        values.add(choice.value);
      }
    }

    if (field.type === 'number' && field.min !== undefined && field.max !== undefined) {
      if (field.min > field.max) {
        problems.push({
          field: field.key,
          message: 'The lowest accepted value is above the highest.',
        });
      }
    }
  }

  return problems;
}

/**
 * A key that has been published keeps its type forever (doc 03 §4).
 *
 * Removing a field is allowed, since a form can stop collecting something.
 * Reusing its key for a different type is not, because February's stored
 * numbers would then be read back through March's option list.
 */
export function validateAgainstPublished(
  schema: TemplateSchema,
  publishedTypes: ReadonlyMap<string, FieldType>,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];

  for (const field of schema.fields) {
    const previous = publishedTypes.get(field.key);
    if (previous !== undefined && previous !== field.type) {
      problems.push({
        field: field.key,
        message: `This key was published as a ${previous} field. Use a new key instead of changing its type.`,
      });
    }
  }

  return problems;
}

/**
 * What publishing would change, shown to the admin before they commit to it
 * (doc 06 §5). Existing records keep the old version either way, which is the
 * point of the warning next to this diff on screen.
 */
export type SchemaDiff = {
  added: string[];
  removed: string[];
  relabelled: { key: string; from: string; to: string }[];
  changed: { key: string; what: string }[];
};

export function diffTemplateSchemas(
  previous: TemplateSchema | null,
  next: TemplateSchema,
): SchemaDiff {
  const before = new Map((previous?.fields ?? []).map((field) => [field.key, field]));
  const after = new Map(next.fields.map((field) => [field.key, field]));

  const diff: SchemaDiff = { added: [], removed: [], relabelled: [], changed: [] };

  for (const [key, field] of after) {
    const old = before.get(key);
    if (!old) {
      diff.added.push(key);
      continue;
    }
    if (old.label !== field.label) {
      diff.relabelled.push({ key, from: old.label, to: field.label });
    }
    if (old.required !== field.required) {
      diff.changed.push({ key, what: field.required ? 'now required' : 'no longer required' });
    }
    if (
      old.type === 'number' &&
      field.type === 'number' &&
      (old.unit !== field.unit || old.decimals !== field.decimals)
    ) {
      diff.changed.push({ key, what: `unit or decimals changed` });
    }
    const oldChoices = choicesOf(old)
      .map((choice) => choice.value)
      .join(',');
    const newChoices = choicesOf(field)
      .map((choice) => choice.value)
      .join(',');
    if (oldChoices !== newChoices) {
      diff.changed.push({ key, what: 'options changed' });
    }
  }

  for (const key of before.keys()) {
    if (!after.has(key)) diff.removed.push(key);
  }

  diff.added.sort();
  diff.removed.sort();
  return diff;
}

export function isEmptyDiff(diff: SchemaDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.relabelled.length === 0 &&
    diff.changed.length === 0
  );
}

/**
 * The wire shapes (doc 04 §5). A version's schema travels whole, because a
 * device needs the frozen field set to render a historical entry the way it was
 * recorded.
 */
export const templateStatuses = ['active', 'retired'] as const;
export const templateStatusSchema = z.enum(templateStatuses);
export type TemplateStatus = z.infer<typeof templateStatusSchema>;

export const versionStatuses = ['draft', 'published', 'superseded'] as const;
export const versionStatusSchema = z.enum(versionStatuses);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const templateVersionSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  version: z.number(),
  status: versionStatusSchema,
  schema: templateSchemaSchema,
  publishedAt: z.string().nullable(),
  publishedByName: z.string().nullable(),
  createdAt: z.string(),
});

export type TemplateVersion = z.infer<typeof templateVersionSchema>;

export const checkTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: templateStatusSchema,
  publishedVersion: templateVersionSchema.nullable(),
  draftVersion: templateVersionSchema.nullable(),
  versionCount: z.number(),
  /** Schedules pointing at it, so retiring one says what it would affect. */
  scheduleCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CheckTemplate = z.infer<typeof checkTemplateSchema>;

export const createTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;

export const updateTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    status: templateStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

/** Draft only. A published version is immutable and rejects with `conflict`. */
export const updateVersionRequestSchema = z.object({ schema: templateSchemaSchema }).strict();

export type UpdateVersionRequest = z.infer<typeof updateVersionRequestSchema>;

export const publishPreviewSchema = z.object({
  diff: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    relabelled: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })),
    changed: z.array(z.object({ key: z.string(), what: z.string() })),
  }),
  problems: z.array(z.object({ field: z.string().nullable(), message: z.string() })),
});

export type PublishPreview = z.infer<typeof publishPreviewSchema>;

/** A label an admin typed, as a starting key. Editable until first publish. */
export function suggestFieldKey(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
  return /^[a-z]/.test(key) ? key : `field_${key}`.slice(0, 63);
}

/**
 * One recorded value, rendered for a human.
 *
 * Used by the daily PDF, the CSV export and anywhere on screen a value is
 * shown as text rather than in an input. One implementation, because a report
 * handed to a family that says `cpap` where the screen says `CPAP` is a report
 * that looks like it came from a different system.
 *
 * Choice values are resolved to their labels, because the stored value is a
 * key the org chose and the label is the words they use. Nothing here colours,
 * flags or judges a value (CLAUDE.md).
 */
export function formatFieldValue(
  field: TemplateField | undefined,
  value: {
    number?: number | null;
    bool?: boolean | null;
    text?: string | null;
    json?: string | string[] | null;
    unit?: string | null;
  },
): string {
  if (value.number !== null && value.number !== undefined) {
    const unit = value.unit ?? (field?.type === 'number' ? field.unit : null);
    const decimals = field?.type === 'number' ? (field.decimals ?? 0) : 0;
    const shown = decimals > 0 ? value.number.toFixed(decimals) : String(value.number);
    return unit ? `${shown} ${unit}` : shown;
  }

  if (value.bool !== null && value.bool !== undefined) return value.bool ? 'Yes' : 'No';

  if (value.json !== null && value.json !== undefined) {
    const chosen = Array.isArray(value.json) ? value.json : [value.json];
    return chosen.map((one) => choiceLabel(field, one)).join(', ');
  }

  if (value.text !== null && value.text !== undefined && value.text !== '') return value.text;

  return '';
}

/** The org's own words for a stored choice key, or the key if it has gone. */
function choiceLabel(field: TemplateField | undefined, value: string): string {
  const choices =
    field?.type === 'single_choice' || field?.type === 'multi_choice'
      ? field.options
      : field?.type === 'checklist'
        ? field.items
        : [];

  return choices.find((choice) => choice.value === value)?.label ?? value;
}
