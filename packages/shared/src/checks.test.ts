import { describe, expect, it } from 'vitest';
import {
  hasValue,
  isEntryComplete,
  missReasonProblem,
  missingRequiredKeys,
  putEntryRequestSchema,
  validateFieldValue,
  validateValues,
  type CheckValue,
} from './checks.js';
import { templateSchemaSchema, type TemplateField, type TemplateSchema } from './templates.js';

const SCHEMA: TemplateSchema = templateSchemaSchema.parse({
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
      maxLength: 20,
      required: false,
      sort: 50,
    },
    { key: 'seen_on', label: 'Seen on', type: 'date', required: false, sort: 60 },
    { key: 'seen_at', label: 'Seen at', type: 'time', required: false, sort: 70 },
  ],
});

function field(key: string): TemplateField {
  return SCHEMA.fields.find((one) => one.key === key)!;
}

function value(overrides: Partial<CheckValue> & { fieldKey: string }): CheckValue {
  return overrides;
}

describe('presence', () => {
  it('knows an answered field from a cleared one', () => {
    expect(hasValue({ fieldKey: 'a', number: 0 })).toBe(true);
    expect(hasValue({ fieldKey: 'a', bool: false })).toBe(true);
    expect(hasValue({ fieldKey: 'a', number: null })).toBe(false);
    expect(hasValue({ fieldKey: 'a' })).toBe(false);
    expect(hasValue({ fieldKey: 'a', text: '   ' })).toBe(false);
    expect(hasValue({ fieldKey: 'a', json: [] })).toBe(false);
    expect(hasValue({ fieldKey: 'a', json: ['x'] })).toBe(true);
  });

  it('counts zero and false as answers, because they are', () => {
    expect(hasValue({ fieldKey: 'urine_output', number: 0 })).toBe(true);
    expect(
      isEntryComplete(SCHEMA, [
        { fieldKey: 'urine_output', number: 0 },
        { fieldKey: 'vent_mode', json: 'cpap' },
      ]),
    ).toBe(true);
  });
});

describe('field validation', () => {
  it('accepts a good number', () => {
    expect(
      validateFieldValue(field('urine_output'), value({ fieldKey: 'urine_output', number: 350 })),
    ).toBeNull();
  });

  it('rejects a number outside the input bounds', () => {
    expect(
      validateFieldValue(field('urine_output'), value({ fieldKey: 'urine_output', number: 9000 })),
    ).toContain('cannot be above');
    expect(
      validateFieldValue(field('urine_output'), value({ fieldKey: 'urine_output', number: -1 })),
    ).toContain('cannot be below');
  });

  it('rejects more decimal places than the field allows', () => {
    expect(
      validateFieldValue(field('urine_output'), value({ fieldKey: 'urine_output', number: 350.5 })),
    ).toContain('whole number');
  });

  it('rejects a choice that is not on the list', () => {
    expect(
      validateFieldValue(field('vent_mode'), value({ fieldKey: 'vent_mode', json: 'cpap' })),
    ).toBeNull();
    expect(
      validateFieldValue(field('vent_mode'), value({ fieldKey: 'vent_mode', json: 'oscillator' })),
    ).toContain('not an option');
  });

  it('rejects a repeated checklist item', () => {
    expect(
      validateFieldValue(
        field('cares'),
        value({ fieldKey: 'cares', json: ['repositioned', 'repositioned'] }),
      ),
    ).toContain('same option twice');
  });

  it('rejects text past the limit', () => {
    expect(
      validateFieldValue(field('comment'), value({ fieldKey: 'comment', text: 'x'.repeat(21) })),
    ).toContain('limited to 20');
  });

  it('checks date and time shapes', () => {
    expect(
      validateFieldValue(field('seen_on'), value({ fieldKey: 'seen_on', json: '2026-07-27' })),
    ).toBeNull();
    expect(
      validateFieldValue(field('seen_on'), value({ fieldKey: 'seen_on', json: '27/07/2026' })),
    ).not.toBeNull();
    expect(
      validateFieldValue(field('seen_at'), value({ fieldKey: 'seen_at', json: '09:14' })),
    ).toBeNull();
    expect(
      validateFieldValue(field('seen_at'), value({ fieldKey: 'seen_at', json: '9am' })),
    ).not.toBeNull();
  });

  it('passes a cleared field, since clearing is an edit and not a bad value', () => {
    expect(
      validateFieldValue(field('urine_output'), value({ fieldKey: 'urine_output', number: null })),
    ).toBeNull();
  });

  it('reports every problem at once', () => {
    const problems = validateValues(SCHEMA, [
      { fieldKey: 'urine_output', number: 9000 },
      { fieldKey: 'vent_mode', json: 'oscillator' },
      { fieldKey: 'gone_away', text: 'hello' },
    ]);
    expect(problems.map((one) => one.fieldKey)).toEqual(['urine_output', 'vent_mode', 'gone_away']);
    expect(problems[2]?.message).toContain('no longer has that field');
  });
});

describe('completeness', () => {
  it('is partial until every required field has a value', () => {
    expect(missingRequiredKeys(SCHEMA, [])).toEqual(['urine_output', 'vent_mode']);
    expect(missingRequiredKeys(SCHEMA, [{ fieldKey: 'urine_output', number: 350 }])).toEqual([
      'vent_mode',
    ]);
    expect(
      isEntryComplete(SCHEMA, [
        { fieldKey: 'urine_output', number: 350 },
        { fieldKey: 'vent_mode', json: 'bipap' },
        { fieldKey: 'comment', text: 'Settled.' },
      ]),
    ).toBe(true);
  });

  it('does not count an optional field towards completeness', () => {
    expect(isEntryComplete(SCHEMA, [{ fieldKey: 'suction_done', bool: true }])).toBe(false);
  });
});

describe('the entry upsert', () => {
  it('needs a client-generated id so a retry updates the same row', () => {
    const request = {
      entryId: '0192f3c1-7a2b-7000-8000-1f2e3d4c5b6a',
      templateVersionId: '3f1c9c8e-1f4e-4a10-8f9d-2b7c4d5e6f70',
      recordedAt: '2026-07-27T09:14:22+10:00',
      values: [{ fieldKey: 'urine_output', number: 350 }],
    };
    expect(putEntryRequestSchema.safeParse(request).success).toBe(true);
    expect(putEntryRequestSchema.safeParse({ ...request, entryId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('refuses a value slot nobody defined', () => {
    const request = {
      entryId: '0192f3c1-7a2b-7000-8000-1f2e3d4c5b6a',
      templateVersionId: '3f1c9c8e-1f4e-4a10-8f9d-2b7c4d5e6f70',
      recordedAt: '2026-07-27T09:14:22+10:00',
      values: [{ fieldKey: 'urine_output', number: 350, severity: 'high' }],
    };
    expect(putEntryRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('miss reasons', () => {
  it('asks for a note only when the code says so', () => {
    expect(missReasonProblem({ requiresNote: false, label: 'Asleep' }, null)).toBeNull();
    expect(missReasonProblem({ requiresNote: true, label: 'Other' }, null)).toContain(
      'needs a short note',
    );
    expect(missReasonProblem({ requiresNote: true, label: 'Other' }, '  ')).not.toBeNull();
    expect(missReasonProblem({ requiresNote: true, label: 'Other' }, 'Power cut')).toBeNull();
  });
});
