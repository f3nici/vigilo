import { describe, expect, it } from 'vitest';
import {
  administrationProblem,
  countDoses,
  createMedicationRequestSchema,
  describeAmountGiven,
  describeMedication,
  doseCutoff,
  doseSortRank,
  duplicateScheduleTimes,
  medicationScheduleInputSchema,
  nextDoseStatus,
  noteIsRequired,
  recordPrnRequestSchema,
  signOffRequestSchema,
  signedOffPercent,
  witnessIsRequired,
  type AdministrationStatus,
  type DoseStatus,
} from './medications.js';

const GRACE = 60;
const DUE = new Date('2026-03-02T08:00:00Z');

function status(overrides: {
  expected?: boolean;
  administration?: AdministrationStatus | null;
  now?: Date;
}): DoseStatus {
  return nextDoseStatus({
    expected: overrides.expected ?? true,
    administration: overrides.administration ?? null,
    dueAt: DUE,
    graceMinutes: GRACE,
    now: overrides.now ?? DUE,
  });
}

describe('the dose state machine', () => {
  it('is pending inside the grace period', () => {
    expect(status({ now: new Date('2026-03-02T08:59:00Z') })).toBe('pending');
  });

  it('is missed once the grace period passes with no sign-off', () => {
    expect(status({ now: new Date('2026-03-02T09:00:00Z') })).toBe('missed');
  });

  it('takes a late sign-off over missed', () => {
    // The dose was given. That it was given an hour late is a separate fact,
    // carried by is_late, and refusing to record it would destroy the only
    // evidence the person got their medication at all.
    expect(status({ administration: 'given', now: new Date('2026-03-02T11:00:00Z') })).toBe(
      'given',
    );
  });

  it('is not required when coverage says the team was not there', () => {
    // Doc 01 §7.2: family-administered doses must not be counted as missed.
    expect(status({ expected: false, now: new Date('2026-03-03T00:00:00Z') })).toBe('not_required');
  });

  it('still takes a sign-off on a dose nobody expected', () => {
    // A worker who was there anyway recorded it. The record wins over the rule
    // that said nobody would be there to make one.
    expect(status({ expected: false, administration: 'given' })).toBe('given');
  });

  it('puts the cut-off a grace period after the due time', () => {
    expect(doseCutoff(DUE, GRACE).toISOString()).toBe('2026-03-02T09:00:00.000Z');
  });
});

describe('sign-off rules', () => {
  const base = {
    note: null,
    witnessedBy: null,
    requiresWitness: false,
    recordedBy: 'worker-1',
  };

  it('needs a note on a refusal and on a withholding', () => {
    expect(noteIsRequired('refused')).toBe(true);
    expect(noteIsRequired('withheld')).toBe(true);
    expect(noteIsRequired('given')).toBe(false);
    expect(noteIsRequired('not_required')).toBe(false);
    expect(noteIsRequired('self_administered')).toBe(false);
  });

  it('refuses a refusal with no note, in words a worker can act on', () => {
    expect(administrationProblem({ ...base, status: 'refused' })).toBe(
      'Say what happened when the dose was refused.',
    );
    expect(administrationProblem({ ...base, status: 'withheld' })).toBe(
      'Say why the dose was withheld.',
    );
  });

  it('treats whitespace as no note at all', () => {
    expect(administrationProblem({ ...base, status: 'refused', note: '   ' })).not.toBeNull();
    expect(administrationProblem({ ...base, status: 'refused', note: 'Spat it out' })).toBeNull();
  });

  it('needs a witness only when the dose was actually handed over', () => {
    expect(witnessIsRequired('given', true)).toBe(true);
    expect(witnessIsRequired('self_administered', true)).toBe(false);
    expect(witnessIsRequired('refused', true)).toBe(false);
    expect(witnessIsRequired('given', false)).toBe(false);
  });

  it('refuses a witnessed medication signed off with no witness', () => {
    expect(administrationProblem({ ...base, status: 'given', requiresWitness: true })).toBe(
      'This medication needs a second person to witness the dose.',
    );
  });

  it('refuses a worker witnessing themselves', () => {
    // A countersignature by the person who gave the dose is not a second pair
    // of eyes, it is the same pair twice.
    expect(
      administrationProblem({
        ...base,
        status: 'given',
        requiresWitness: true,
        witnessedBy: 'worker-1',
      }),
    ).toBe('A witness has to be someone other than you.');
  });

  it('accepts a witness on a sign-off that did not need one', () => {
    expect(
      administrationProblem({ ...base, status: 'refused', note: 'Asleep', witnessedBy: 'nurse-2' }),
    ).toBeNull();
  });

  it('takes an amount on a dose that reached the person', () => {
    expect(
      administrationProblem({ ...base, status: 'given', amountGiven: 'half a tablet' }),
    ).toBeNull();
    expect(
      administrationProblem({ ...base, status: 'self_administered', amountGiven: '7.5 mL' }),
    ).toBeNull();
  });

  it('refuses an amount on a sign-off that says nothing was given', () => {
    expect(
      administrationProblem({
        ...base,
        status: 'refused',
        note: 'Spat it out',
        amountGiven: '5 mg',
      }),
    ).toBe('Nothing was given, so there is no amount to record.');
    expect(administrationProblem({ ...base, status: 'given', amountGiven: '   ' })).toBeNull();
  });
});

describe('the amount actually given', () => {
  it('reads as the charted dose when nothing else was said', () => {
    expect(describeAmountGiven('500 mg', null)).toBe('500 mg');
    expect(describeAmountGiven('500 mg', '  ')).toBe('500 mg');
  });

  /** Repeating it would read "500 mg, gave 500 mg", which says nothing twice. */
  it('says nothing extra when the amount matches the chart', () => {
    expect(describeAmountGiven('500 mg', '500 mg')).toBe('500 mg');
  });

  it('shows what was given when it differs from the chart', () => {
    expect(describeAmountGiven('1 to 2 tablets', '1 tablet')).toBe('1 to 2 tablets, gave 1 tablet');
  });
});

describe('the sign-off wire shapes', () => {
  const now = '2026-03-02T08:05:00.000Z';

  it('defaults the amount to nothing, so an old client still parses', () => {
    const parsed = signOffRequestSchema.parse({
      id: '018f8f8f-8f8f-7f8f-8f8f-8f8f8f8f8f8f',
      status: 'given',
      administeredAt: now,
      recordedAt: now,
    });
    expect(parsed.amountGiven).toBeNull();
  });

  it('trims the amount rather than storing the spaces somebody typed', () => {
    const parsed = recordPrnRequestSchema.parse({
      id: '018f8f8f-8f8f-7f8f-8f8f-8f8f8f8f8f8f',
      medicationId: '018f8f8f-8f8f-7f8f-8f8f-8f8f8f8f8f90',
      status: 'given',
      administeredAt: now,
      recordedAt: now,
      amountGiven: '  2 tablets ',
      reason: 'Headache',
    });
    expect(parsed.amountGiven).toBe('2 tablets');
  });
});

describe('counting doses', () => {
  function dose(overrides: Partial<{ status: DoseStatus; expected: boolean; isLate: boolean }>) {
    return { status: 'given' as DoseStatus, expected: true, isLate: false, ...overrides };
  }

  it('keeps unexpected doses out of the denominator', () => {
    const counts = countDoses([
      dose({}),
      dose({ expected: false, status: 'not_required' }),
      dose({ expected: false, status: 'not_required' }),
    ]);

    expect(counts.expected).toBe(1);
    expect(counts.notExpected).toBe(2);
    expect(signedOffPercent(counts)).toBe(100);
  });

  it('adds up, column by column', () => {
    // The same rule the compliance table has to obey: every part sums to the
    // total, or an auditor stops trusting the table.
    const counts = countDoses([
      dose({ status: 'given' }),
      dose({ status: 'given', isLate: true }),
      dose({ status: 'refused' }),
      dose({ status: 'withheld' }),
      dose({ status: 'self_administered' }),
      dose({ status: 'not_required' }),
      dose({ status: 'pending' }),
      dose({ status: 'missed' }),
    ]);

    expect(counts.expected).toBe(8);
    expect(counts.givenLate).toBe(1);
    expect(
      counts.given +
        counts.refused +
        counts.withheld +
        counts.selfAdministered +
        counts.notRequired +
        counts.pending +
        counts.missed,
    ).toBe(counts.expected);
  });

  it('has no percentage when nothing was expected', () => {
    // D51 again. 100 percent for a period nobody was rostered would flatter
    // exactly the period that deserves a question.
    expect(signedOffPercent(countDoses([dose({ expected: false })]))).toBeNull();
  });

  it('counts a dose still inside its grace period as neither done nor missed', () => {
    const counts = countDoses([dose({ status: 'pending' }), dose({ status: 'given' })]);
    expect(signedOffPercent(counts)).toBe(50);
  });
});

describe('ordering', () => {
  it('puts a missed dose above one still due, and both above the answered', () => {
    const ranks = (['given', 'pending', 'missed'] as DoseStatus[])
      .map((one) => ({ status: one }))
      .sort((a, b) => doseSortRank(a) - doseSortRank(b))
      .map((one) => one.status);

    expect(ranks).toEqual(['missed', 'pending', 'given']);
  });
});

describe('the definition', () => {
  it('reads as a chart line', () => {
    expect(
      describeMedication({ name: 'Paracetamol', dose: '500 mg', form: 'tablet', route: 'oral' }),
    ).toBe('Paracetamol 500 mg, tablet, oral');
  });

  it('leaves out the parts nobody filled in', () => {
    expect(describeMedication({ name: 'Ventolin', dose: '2 puffs', form: null, route: null })).toBe(
      'Ventolin 2 puffs',
    );
  });

  it('keeps a dose exactly as it was typed', () => {
    // Not parsed, not normalised, not converted. It is transcribed off a label
    // and has to survive the trip unchanged.
    const parsed = createMedicationRequestSchema.parse({
      name: 'Movicol',
      dose: 'half a sachet',
      startDate: '2026-03-01',
    });
    expect(parsed.dose).toBe('half a sachet');
    expect(parsed.isPrn).toBe(false);
    expect(parsed.requiresWitness).toBe(false);
  });

  it('refuses an end date before the start', () => {
    const result = createMedicationRequestSchema.safeParse({
      name: 'Keppra',
      dose: '250 mg',
      startDate: '2026-03-10',
      endDate: '2026-03-01',
    });
    expect(result.success).toBe(false);
  });
});

describe('schedules', () => {
  function schedule(timeOfDay: string, weekdays: number[] | null = null) {
    return medicationScheduleInputSchema.parse({ timeOfDay, weekdays });
  }

  it('finds two rows asking for the same time on the same day', () => {
    // Two doses at 08:00 means a worker signs off one and is chased for the
    // other for ever.
    expect(duplicateScheduleTimes([schedule('08:00'), schedule('08:00')])).toEqual(['08:00']);
  });

  it('allows the same time on days that do not overlap', () => {
    expect(duplicateScheduleTimes([schedule('08:00', [1]), schedule('08:00', [2])])).toEqual([]);
  });

  it('catches a daily row clashing with a weekday one', () => {
    expect(duplicateScheduleTimes([schedule('20:00'), schedule('20:00', [3])])).toEqual(['20:00']);
  });
});

describe('PRN', () => {
  it('needs a reason and takes the outcome later', () => {
    const parsed = recordPrnRequestSchema.parse({
      id: '01952d3f-0000-7000-8000-000000000001',
      medicationId: '01952d3f-0000-7000-8000-000000000002',
      status: 'given',
      administeredAt: '2026-03-02T08:00:00Z',
      recordedAt: '2026-03-02T08:02:00Z',
      reason: 'Reported a headache',
    });

    expect(parsed.reason).toBe('Reported a headache');
    expect(parsed.outcome).toBeNull();
  });

  it('refuses a PRN dose with no reason', () => {
    const result = recordPrnRequestSchema.safeParse({
      id: '01952d3f-0000-7000-8000-000000000001',
      medicationId: '01952d3f-0000-7000-8000-000000000002',
      status: 'given',
      administeredAt: '2026-03-02T08:00:00Z',
      recordedAt: '2026-03-02T08:02:00Z',
      reason: '   ',
    });
    expect(result.success).toBe(false);
  });
});
