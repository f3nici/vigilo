import { describe, expect, it } from 'vitest';
import {
  buildCheckFormExport,
  checkFormExportSchema,
  diffTemplateSchemas,
  fieldRecordsValue,
  formatFieldValue,
  isEmptyDiff,
  orderedFields,
  requiredFieldKeys,
  suggestFieldKey,
  templateSchemaSchema,
  uniqueFormName,
  validateAgainstPublished,
  validateTemplateSchema,
  type FieldType,
  type TemplateSchema,
} from './templates.js';

/** The vent observation template the documents use throughout. */
const VENT: TemplateSchema = templateSchemaSchema.parse({
  fields: [
    {
      key: 'urine_output',
      label: 'Urine output',
      type: 'number',
      unit: 'ml',
      decimals: 0,
      min: 0,
      max: 5000,
      required: true,
      help: 'Since the last check',
      sort: 10,
    },
    {
      key: 'vent_mode',
      label: 'Ventilator mode',
      type: 'single_choice',
      options: [
        { value: 'cpap', label: 'CPAP' },
        { value: 'bipap', label: 'BiPAP' },
      ],
      required: true,
      sort: 20,
    },
    { key: 'suction_done', label: 'Suction performed', type: 'boolean', required: false, sort: 30 },
    {
      key: 'cares',
      label: 'Cares completed',
      type: 'checklist',
      items: [
        { value: 'repositioned', label: 'Repositioned' },
        { value: 'mouth_care', label: 'Mouth care' },
      ],
      required: false,
      sort: 40,
    },
    {
      key: 'comment',
      label: 'Comment',
      type: 'text',
      multiline: true,
      maxLength: 2000,
      required: false,
      sort: 50,
    },
  ],
});

describe('schema parsing', () => {
  it('accepts the template from the docs', () => {
    expect(VENT.fields).toHaveLength(5);
    expect(requiredFieldKeys(VENT)).toEqual(['urine_output', 'vent_mode']);
  });

  it('orders by sort, then key', () => {
    expect(orderedFields(VENT).map((field) => field.key)).toEqual([
      'urine_output',
      'vent_mode',
      'suction_done',
      'cares',
      'comment',
    ]);
  });

  /**
   * D14, and the reason every field object is strict. An admin cannot add a
   * normal range by hand-editing JSON, because the parser has nowhere to put
   * it. This is the enforcement of "Vigilo records values, it does not judge
   * them", not a convention someone can quietly drop.
   */
  it('refuses a normal range on a field', () => {
    const withRange = {
      fields: [
        {
          key: 'urine_output',
          label: 'Urine output',
          type: 'number',
          unit: 'ml',
          decimals: 0,
          required: true,
          sort: 10,
          normalRange: { low: 300, high: 800 },
        },
      ],
    };
    expect(templateSchemaSchema.safeParse(withRange).success).toBe(false);
  });

  it('refuses a threshold or an alert setting under any name', () => {
    for (const extra of [
      { threshold: 500 },
      { alertOn: 'high' },
      { criticalHigh: 900 },
      { targetRange: [1, 2] },
      { colourBy: 'value' },
    ]) {
      const field = {
        key: 'reading',
        label: 'Reading',
        type: 'number',
        unit: 'ml',
        decimals: 0,
        required: false,
        sort: 10,
        ...extra,
      };
      expect(templateSchemaSchema.safeParse({ fields: [field] }).success).toBe(false);
    }
  });

  it('keeps min and max, which are input bounds and nothing more', () => {
    const parsed = templateSchemaSchema.parse({
      fields: [
        {
          key: 'reading',
          label: 'Reading',
          type: 'number',
          unit: 'ml',
          decimals: 0,
          min: 0,
          max: 5000,
          required: false,
          sort: 10,
        },
      ],
    });
    const field = parsed.fields[0]!;
    expect(field.type === 'number' && field.min).toBe(0);
  });

  it('refuses a choice field with no options', () => {
    const empty = {
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'single_choice',
          options: [],
          required: true,
          sort: 10,
        },
      ],
    };
    expect(templateSchemaSchema.safeParse(empty).success).toBe(false);
  });

  it('takes a number field with no unit, because some things are counts', () => {
    const noUnit = {
      fields: [
        { key: 'repositions', label: 'Repositions', type: 'number', required: true, sort: 10 },
      ],
    };
    const parsed = templateSchemaSchema.parse(noUnit);
    expect(parsed.fields[0]).toMatchObject({ type: 'number', unit: null });
  });

  it('still refuses an empty unit, which is a blank somebody typed into', () => {
    const blank = {
      fields: [
        { key: 'reading', label: 'Reading', type: 'number', required: true, sort: 10, unit: '  ' },
      ],
    };
    expect(templateSchemaSchema.safeParse(blank).success).toBe(false);
  });

  it('refuses a key that is not a stable identifier', () => {
    for (const key of ['Urine Output', '1st_reading', 'urine-output', '']) {
      const bad = {
        fields: [{ key, label: 'Reading', type: 'boolean', required: false, sort: 10 }],
      };
      expect(templateSchemaSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('publish validation', () => {
  it('passes a good schema', () => {
    expect(validateTemplateSchema(VENT)).toEqual([]);
  });

  it('needs at least one field', () => {
    expect(validateTemplateSchema({ fields: [] })).toHaveLength(1);
  });

  it('catches a duplicate key', () => {
    const duplicated: TemplateSchema = {
      fields: [VENT.fields[2]!, { ...VENT.fields[2]!, label: 'Again', sort: 60 }],
    };
    expect(validateTemplateSchema(duplicated)[0]?.field).toBe('suction_done');
  });

  it('catches a duplicate option value', () => {
    const clashing: TemplateSchema = {
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'single_choice',
          options: [
            { value: 'cpap', label: 'CPAP' },
            { value: 'cpap', label: 'CPAP again' },
          ],
          required: true,
          sort: 10,
        },
      ],
    };
    expect(validateTemplateSchema(clashing)[0]?.message).toContain('cpap');
  });

  it('catches a minimum above the maximum', () => {
    const inverted: TemplateSchema = {
      fields: [
        {
          key: 'reading',
          label: 'Reading',
          type: 'number',
          unit: 'ml',
          decimals: 0,
          min: 100,
          max: 10,
          required: false,
          sort: 10,
        },
      ],
    };
    expect(validateTemplateSchema(inverted)).toHaveLength(1);
  });

  /**
   * Doc 03 §4. February's stored numbers must not be read back through March's
   * option list, so a published key keeps its type forever.
   */
  it('refuses reusing a published key for a different type', () => {
    const published = new Map<string, FieldType>([['urine_output', 'number']]);
    const retyped: TemplateSchema = {
      fields: [
        {
          key: 'urine_output',
          label: 'Urine output',
          type: 'text',
          multiline: false,
          maxLength: 100,
          required: false,
          sort: 10,
        },
      ],
    };
    expect(validateAgainstPublished(retyped, published)).toHaveLength(1);
  });

  it('allows dropping a published field', () => {
    const published = new Map<string, FieldType>([
      ['urine_output', 'number'],
      ['gone', 'boolean'],
    ]);
    expect(validateAgainstPublished(VENT, published)).toEqual([]);
  });
});

describe('publish diff', () => {
  it('reports a first version as all added', () => {
    const diff = diffTemplateSchemas(null, VENT);
    expect(diff.added).toHaveLength(5);
    expect(diff.removed).toEqual([]);
  });

  it('reports nothing when nothing changed', () => {
    expect(isEmptyDiff(diffTemplateSchemas(VENT, VENT))).toBe(true);
  });

  it('reports an added and a removed field', () => {
    const next: TemplateSchema = {
      fields: [
        ...VENT.fields.filter((field) => field.key !== 'comment'),
        {
          key: 'weight',
          label: 'Weight',
          type: 'number',
          unit: 'kg',
          decimals: 1,
          required: false,
          sort: 60,
        },
      ],
    };
    const diff = diffTemplateSchemas(VENT, next);
    expect(diff.added).toEqual(['weight']);
    expect(diff.removed).toEqual(['comment']);
  });

  it('reports a relabel separately from a change', () => {
    const next: TemplateSchema = {
      fields: VENT.fields.map((field) =>
        field.key === 'urine_output' ? { ...field, label: 'Urine output (total)' } : field,
      ),
    };
    const diff = diffTemplateSchemas(VENT, next);
    expect(diff.relabelled).toEqual([
      { key: 'urine_output', from: 'Urine output', to: 'Urine output (total)' },
    ]);
    expect(diff.changed).toEqual([]);
  });

  it('reports a required flag flipping and options changing', () => {
    const next: TemplateSchema = {
      fields: VENT.fields.map((field) => {
        if (field.key === 'suction_done') return { ...field, required: true };
        if (field.key === 'vent_mode' && field.type === 'single_choice') {
          return { ...field, options: [...field.options, { value: 'psv', label: 'PSV' }] };
        }
        return field;
      }),
    };
    const diff = diffTemplateSchemas(VENT, next);
    expect(diff.changed).toContainEqual({ key: 'suction_done', what: 'now required' });
    expect(diff.changed).toContainEqual({ key: 'vent_mode', what: 'options changed' });
  });
});

describe('several times on one field', () => {
  const nebs = templateSchemaSchema.parse({
    fields: [
      {
        key: 'neb_times',
        label: 'Nebuliser given at',
        type: 'time',
        sort: 10,
        allowMultiple: true,
      },
    ],
  });

  it('defaults to one time, so an existing form is unchanged', () => {
    const single = templateSchemaSchema.parse({
      fields: [{ key: 'woke_at', label: 'Woke at', type: 'time', sort: 10 }],
    });
    expect(single.fields[0]).toMatchObject({ type: 'time', allowMultiple: false });
  });

  it('reads a list of times as times rather than as choices', () => {
    // Nothing resolves these to a label, and the comma is what tells one from
    // the next.
    expect(formatFieldValue(nebs.fields[0], { json: ['09:10', '10:40'] })).toBe('09:10, 10:40');
  });

  it('reads in clock order whatever order it was stored in', () => {
    /*
     * The app adds them in clock order, but the API stores what it is sent, and
     * a replayed outbox row can arrive any way round. The released image did
     * exactly this. A record reading "15:30, 09:10" makes the reader work out
     * which came first.
     */
    expect(formatFieldValue(nebs.fields[0], { json: ['15:30', '09:10'] })).toBe('09:10, 15:30');
  });

  it('leaves a choice list in the order it was recorded', () => {
    // Only times are re-ordered. A checklist's order is the form's order.
    const cares = templateSchemaSchema.parse({
      fields: [
        {
          key: 'cares',
          label: 'Cares',
          type: 'checklist',
          sort: 10,
          items: [
            { value: 'mouth_care', label: 'Mouth care' },
            { value: 'repositioned', label: 'Repositioned' },
          ],
        },
      ],
    });
    expect(formatFieldValue(cares.fields[0], { json: ['repositioned', 'mouth_care'] })).toBe(
      'Repositioned, Mouth care',
    );
  });

  it('names the change when a form starts taking several', () => {
    const before = templateSchemaSchema.parse({
      fields: [{ key: 'neb_times', label: 'Nebuliser given at', type: 'time', sort: 10 }],
    });
    expect(diffTemplateSchemas(before, nebs).changed).toEqual([
      { key: 'neb_times', what: 'now takes several times' },
    ]);
  });
});

describe('a block of guidance', () => {
  const withInfo = templateSchemaSchema.parse({
    fields: [
      {
        key: 'secretions_chart',
        label: 'Types of secretion',
        type: 'info',
        sort: 10,
        body: '| Type | Looks like |\n| - | - |\n| 1 | Clear |',
      },
      { key: 'secretion_type', label: 'Type seen', type: 'number', sort: 20, required: true },
    ],
  });

  it('records nothing', () => {
    const [info, number] = withInfo.fields;
    expect(fieldRecordsValue(info!)).toBe(false);
    expect(fieldRecordsValue(number!)).toBe(true);
  });

  it('can never be required, so it cannot hold a check open', () => {
    expect(requiredFieldKeys(withInfo)).toEqual(['secretion_type']);

    // Not merely defaulted false: there is nowhere in the schema to put a true.
    const forced = {
      fields: [
        { key: 'note', label: 'Note', type: 'info', sort: 10, body: 'Read this.', required: true },
      ],
    };
    expect(templateSchemaSchema.safeParse(forced).success).toBe(false);
  });

  it('needs a body, because an empty block of guidance is a blank on the form', () => {
    const empty = {
      fields: [{ key: 'note', label: 'Note', type: 'info', sort: 10, body: '   ' }],
    };
    expect(templateSchemaSchema.safeParse(empty).success).toBe(false);
  });

  it('refuses a form that is only guidance', () => {
    // A window bound to one could never be anything but complete, and what the
    // admin has built is a care plan rather than a check form.
    const onlyGuidance = templateSchemaSchema.parse({
      fields: [{ key: 'note', label: 'Note', type: 'info', sort: 10, body: 'Read this.' }],
    });
    expect(validateTemplateSchema(onlyGuidance)).toEqual([
      {
        field: null,
        message: 'This form only has guidance on it. Add at least one field a worker fills in.',
      },
    ]);
    expect(validateTemplateSchema(withInfo)).toEqual([]);
  });

  it('names a reworded block in the publish diff', () => {
    const reworded = templateSchemaSchema.parse({
      fields: [{ ...withInfo.fields[0], body: 'Something else entirely.' }, withInfo.fields[1]],
    });
    expect(diffTemplateSchemas(withInfo, reworded).changed).toEqual([
      { key: 'secretions_chart', what: 'guidance reworded' },
    ]);
  });
});

describe('key suggestions', () => {
  it('turns a label into a usable key', () => {
    expect(suggestFieldKey('Urine output')).toBe('urine_output');
    expect(suggestFieldKey('Ventilator mode (set)')).toBe('ventilator_mode_set');
    expect(suggestFieldKey('  Weight  ')).toBe('weight');
  });

  it('keeps a key starting with a letter', () => {
    expect(suggestFieldKey('2 hourly reading')).toBe('field_2_hourly_reading');
  });
});

describe('exporting and importing check forms', () => {
  const document = buildCheckFormExport(
    [{ name: 'Vent observations', description: '2-hourly', schema: VENT }],
    new Date('2026-08-03T02:00:00Z'),
  );

  it('round-trips a form through the document and back', () => {
    const parsed = checkFormExportSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(parsed.forms[0]!.name).toBe('Vent observations');
    expect(parsed.forms[0]!.schema).toEqual(VENT);
  });

  /**
   * Identity is what must not travel. An imported form is a new form where it
   * lands, so nothing in the file can point at a template, a version or a
   * publication that only means something in the installation it came from.
   */
  it('carries no ids, versions or publication history', () => {
    const keys = Object.keys(document.forms[0]!).sort();
    expect(keys).toEqual(['description', 'name', 'schema']);
  });

  it('refuses a file written by a later version rather than dropping fields', () => {
    expect(checkFormExportSchema.safeParse({ ...document, version: 2 }).success).toBe(false);
  });

  it('refuses a file that is not a check form export at all', () => {
    expect(checkFormExportSchema.safeParse({ kind: 'something-else' }).success).toBe(false);
    expect(checkFormExportSchema.safeParse({ ...document, forms: [] }).success).toBe(false);
  });

  it('refuses a field the schema does not define, rather than storing it', () => {
    const smuggled = {
      ...document,
      forms: [
        {
          name: 'Vent observations',
          description: null,
          schema: {
            fields: [
              {
                key: 'spo2',
                label: 'SpO2',
                type: 'number',
                unit: '%',
                decimals: 0,
                sort: 10,
                required: true,
                normalRange: [95, 100],
              },
            ],
          },
        },
      ],
    };
    // D14 again, through the import door this time.
    expect(checkFormExportSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe('naming an imported form', () => {
  it('keeps the name when nothing else has it', () => {
    expect(uniqueFormName('Vent observations', new Set())).toBe('Vent observations');
  });

  it('marks a collision instead of overwriting the form already there', () => {
    const taken = new Set(['Vent observations']);
    expect(uniqueFormName('Vent observations', taken)).toBe('Vent observations (imported)');
  });

  it('counts up when the same file is imported again', () => {
    const taken = new Set(['Vent observations', 'Vent observations (imported)']);
    expect(uniqueFormName('Vent observations', taken)).toBe('Vent observations (imported 2)');
  });

  it('keeps a long name inside the length the name field allows', () => {
    const long = 'V'.repeat(100);
    const name = uniqueFormName(long, new Set([long]));
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(' (imported)')).toBe(true);
  });
});
