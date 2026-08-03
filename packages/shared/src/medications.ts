import { z } from 'zod';
import { timeOfDaySchema, weekdaySchema } from './schedules.js';

/**
 * The medication administration record (doc 01 §7.2, doc 03 §9).
 *
 * Structurally this is the check grid again: a definition, a schedule, doses
 * materialised server-side on a fixed grid, and a sign-off recorded against a
 * dose. That repetition is deliberate. The coverage rules, the offline outbox
 * and the "materialised so a phone with no signal knows what is due" argument
 * were all built for checks and all apply unchanged here, so medication reuses
 * them rather than growing a parallel set that can drift.
 *
 * The two things that are genuinely different are both about consequence. A
 * dose either reached the person or it did not, so a refusal or a withholding
 * has to say why, and a medication can require a second person to witness it.
 * Both rules live here so the phone enforces them at the moment of sign-off,
 * with no signal, rather than the server rejecting the record two hours later
 * when the worker has left the house.
 *
 * Nothing here judges a medication or a dose. No interaction checking, no
 * maximum daily totals, no warnings. Vigilo records what happened
 * (CLAUDE.md).
 */

const isoDateTimeSchema = z.string().datetime({ offset: true });

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker, or type it as YYYY-MM-DD.');

/* ------------------------------------------------------------ definitions */

/**
 * Form, dose and route are free text rather than enumerations.
 *
 * A dose is transcribed off a label or a chart and has to survive the trip
 * unchanged: "5 mg", "2.5 mL", "half a tablet", "1 to 2 tablets". Splitting it
 * into a number and a unit would invite the software to convert, compare or
 * total it, and a system that does arithmetic on doses is a system that can get
 * a dose wrong. It is copied, shown, and never computed with.
 */
export const createMedicationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    form: z.string().trim().max(60).nullable().default(null),
    dose: z.string().trim().min(1).max(100),
    route: z.string().trim().max(60).nullable().default(null),
    instructions: z.string().trim().max(2000).nullable().default(null),
    isPrn: z.boolean().default(false),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable().default(null),
    /** A second person confirms the dose. Per medication, not per organisation. */
    requiresWitness: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => value.endDate === null || value.endDate >= value.startDate,
    'It ends before it starts.',
  );

export type CreateMedicationRequest = z.infer<typeof createMedicationRequestSchema>;

export const updateMedicationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    form: z.string().trim().max(60).nullable().optional(),
    dose: z.string().trim().min(1).max(100).optional(),
    route: z.string().trim().max(60).nullable().optional(),
    instructions: z.string().trim().max(2000).nullable().optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.nullable().optional(),
    requiresWitness: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateMedicationRequest = z.infer<typeof updateMedicationRequestSchema>;

/**
 * One due time. `weekdays` null means every day, the same convention the check
 * grid uses, and for the same reason: an empty list would mean never, which is
 * what deleting the row is for.
 */
export const medicationScheduleInputSchema = z
  .object({
    timeOfDay: timeOfDaySchema,
    weekdays: z.array(weekdaySchema).min(1).max(7).nullable().default(null),
    activeFrom: isoDateSchema.nullable().default(null),
    activeTo: isoDateSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.activeTo === null || value.activeFrom === null || value.activeTo >= value.activeFrom,
    'It ends before it starts.',
  );

export type MedicationScheduleInput = z.infer<typeof medicationScheduleInputSchema>;

/** Replaces the whole set, so duplicate times are checked against the end state. */
export const putMedicationSchedulesRequestSchema = z
  .object({ schedules: z.array(medicationScheduleInputSchema).max(24) })
  .strict();

export type PutMedicationSchedulesRequest = z.infer<typeof putMedicationSchedulesRequestSchema>;

/**
 * Two rows asking for the same medication at the same time on the same day
 * would materialise two doses, and a worker would sign off one and be chased
 * for the other forever.
 */
export function duplicateScheduleTimes(schedules: readonly MedicationScheduleInput[]): string[] {
  const seen = new Map<string, number>();
  for (const schedule of schedules) {
    const days = schedule.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
    for (const day of days) {
      const key = `${day}@${schedule.timeOfDay}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }

  const clashes = new Set<string>();
  for (const [key, count] of seen) {
    if (count > 1) clashes.add(key.split('@')[1] ?? key);
  }
  return [...clashes].sort();
}

export const medicationScheduleSchema = z.object({
  id: z.string(),
  medicationId: z.string(),
  timeOfDay: z.string(),
  weekdays: z.array(z.number()).nullable(),
  activeFrom: z.string().nullable(),
  activeTo: z.string().nullable(),
});

export type MedicationSchedule = z.infer<typeof medicationScheduleSchema>;

export const medicationSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  name: z.string(),
  form: z.string().nullable(),
  dose: z.string(),
  route: z.string().nullable(),
  instructions: z.string().nullable(),
  isPrn: z.boolean(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  requiresWitness: z.boolean(),
  active: z.boolean(),
  schedules: z.array(medicationScheduleSchema),
  createdBy: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Medication = z.infer<typeof medicationSchema>;

/** The line a chart shows: "Paracetamol 500 mg, tablet, oral". */
export function describeMedication(medication: {
  name: string;
  dose: string;
  form: string | null;
  route: string | null;
}): string {
  return [`${medication.name} ${medication.dose}`, medication.form, medication.route]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
}

/* ------------------------------------------------------------------ doses */

export const administrationStatuses = [
  'given',
  'refused',
  'withheld',
  'not_required',
  'self_administered',
] as const;

export const administrationStatusSchema = z.enum(administrationStatuses);
export type AdministrationStatus = z.infer<typeof administrationStatusSchema>;

export const doseStatuses = ['pending', ...administrationStatuses, 'missed'] as const;

export const doseStatusSchema = z.enum(doseStatuses);
export type DoseStatus = z.infer<typeof doseStatusSchema>;

/**
 * How long after a due time a dose is still simply due (doc 01 §7.2 has no
 * number, so this is the equivalent of the window's `ends_at`).
 *
 * An hour, held in org settings. A check has a window with two ends; a dose has
 * one instant, so it needs a grace period or every dose would be missed the
 * second it came due.
 */
export const DEFAULT_MEDICATION_GRACE_MINUTES = 60;

export function doseCutoff(dueAt: Date, graceMinutes: number): Date {
  return new Date(dueAt.getTime() + graceMinutes * 60_000);
}

export type DoseStatusInput = {
  /** False when coverage says the team was not there (doc 01 §7.2). */
  expected: boolean;
  /** The sign-off, if there is one. */
  administration: AdministrationStatus | null;
  dueAt: Date;
  graceMinutes: number;
  now: Date;
};

/**
 * The dose state machine, the medication counterpart of `nextWindowStatus`.
 *
 * ```
 *                 coverage says not covered
 *   [created] ──────────────────────────────► not_required
 *       │                                          │
 *       │ covered                                  │ signed off anyway
 *       ▼                                          ▼
 *    pending ────────── signed off ──────────► given / refused / withheld /
 *       │                                       not_required / self_administered
 *       │ grace period passes
 *       ▼
 *    missed
 * ```
 *
 * `missed` is not terminal, exactly as with a check: a dose signed off two
 * hours late is still a dose that was given, and refusing to record it would
 * destroy the only evidence of that.
 *
 * A coverage-driven `not_required` and a worker-chosen `not_required` are the
 * same word for the same fact, that no dose was owed by this team. They are
 * kept apart in the numbers by `expected` on the row rather than by the status,
 * which is the same split compliance already uses for checks.
 */
export function nextDoseStatus(input: DoseStatusInput): DoseStatus {
  if (input.administration !== null) return input.administration;
  if (!input.expected) return 'not_required';
  if (input.now.getTime() < doseCutoff(input.dueAt, input.graceMinutes).getTime()) return 'pending';
  return 'missed';
}

/** Whether the medication actually reached the person. */
export function medicationWasTaken(status: DoseStatus): boolean {
  return status === 'given' || status === 'self_administered';
}

/** Counted in a medication summary. An unexpected dose is shown separately. */
export function doseCountsTowardCompliance(dose: { expected: boolean }): boolean {
  return dose.expected;
}

export function describeDoseStatus(status: DoseStatus): string {
  switch (status) {
    case 'pending':
      return 'Due';
    case 'given':
      return 'Given';
    case 'refused':
      return 'Refused';
    case 'withheld':
      return 'Withheld';
    case 'not_required':
      return 'Not required';
    case 'self_administered':
      return 'Self-administered';
    case 'missed':
      return 'Missed';
  }
}

export function describeAdministrationStatus(status: AdministrationStatus): string {
  return describeDoseStatus(status);
}

/**
 * Ordering on the Today screen. A dose past its grace period with no sign-off
 * sits above one still due, which sits above everything already answered
 * (doc 06 §3 does this for windows and the same reasoning applies).
 */
export function doseSortRank(dose: { status: DoseStatus }): number {
  if (dose.status === 'missed') return 0;
  if (dose.status === 'pending') return 1;
  return 2;
}

export const medicationDoseSchema = z.object({
  id: z.string(),
  medicationId: z.string(),
  participantId: z.string(),
  /** Denormalised so a dose renders with no join, online or off. */
  medicationName: z.string(),
  dose: z.string(),
  form: z.string().nullable(),
  route: z.string().nullable(),
  instructions: z.string().nullable(),
  requiresWitness: z.boolean(),
  dueAt: z.string(),
  expected: z.boolean(),
  /** Why not, in the words the greyed-out row shows. */
  coverageReason: z.string().nullable(),
  status: doseStatusSchema,
  isLate: z.boolean(),
  administrationId: z.string().nullable(),
});

export type MedicationDose = z.infer<typeof medicationDoseSchema>;

/* --------------------------------------------------------- administration */

/**
 * What a sign-off must say (doc 01 §7.2).
 *
 * Refused and withheld are the two answers that mean the medication did not
 * reach the person, and either can be the beginning of a clinical
 * conversation, so both carry a note. Given, self-administered and not
 * required are self-explanatory and a mandatory note on those would only teach
 * people to type "given".
 */
export function noteIsRequired(status: AdministrationStatus): boolean {
  return status === 'refused' || status === 'withheld';
}

/**
 * A witness is required only for `given`.
 *
 * The witness exists to have a second pair of eyes on the drug, the dose and
 * the person at the moment staff hand it over. A refusal or a withholding has
 * no handover to witness, and a self-administered dose was not handed over by
 * staff at all, so requiring a countersignature on those would be a signature
 * about nothing. A witness may still be recorded on any sign-off if one was
 * there.
 */
export function witnessIsRequired(status: AdministrationStatus, requiresWitness: boolean): boolean {
  return requiresWitness && status === 'given';
}

export type AdministrationCheck = {
  status: AdministrationStatus;
  note: string | null;
  amountGiven?: string | null;
  witnessedBy: string | null;
  requiresWitness: boolean;
  recordedBy: string;
};

/**
 * The whole rule, in the words the worker sees, or null.
 *
 * Both sides call this. The device is the one that matters: a worker standing
 * in a kitchen with no signal has to be told a refusal needs a note while they
 * still remember why, not when the outbox drains.
 */
export function administrationProblem(input: AdministrationCheck): string | null {
  const note = (input.note ?? '').trim();

  if (noteIsRequired(input.status) && note === '') {
    return input.status === 'refused'
      ? 'Say what happened when the dose was refused.'
      : 'Say why the dose was withheld.';
  }

  // An amount is a statement that something went in, so it cannot sit on a
  // sign-off that says nothing did. Refused with "5 mg" against it is a record
  // that reads two ways, and nobody later can tell which one was meant.
  if ((input.amountGiven ?? '').trim() !== '' && !medicationWasTaken(input.status)) {
    return 'Nothing was given, so there is no amount to record.';
  }

  if (witnessIsRequired(input.status, input.requiresWitness) && input.witnessedBy === null) {
    return 'This medication needs a second person to witness the dose.';
  }

  if (input.witnessedBy !== null && input.witnessedBy === input.recordedBy) {
    return 'A witness has to be someone other than you.';
  }

  return null;
}

/**
 * How much actually went in, in the worker's own words.
 *
 * The medication carries what is charted ("5 mg", "1 to 2 tablets"). This
 * carries what was given, which is not always the same thing: half a tablet
 * because that is what was left, 7.5 mL drawn up rather than 10. It is free
 * text for the reason the charted dose is (doc above): nothing converts it,
 * totals it or compares it to the chart, because software that does arithmetic
 * on doses is software that can get a dose wrong.
 *
 * Optional, and blank means the record does not say. Nothing infers "the
 * charted amount" from an empty box, because that would be the software
 * writing a clinical record nobody typed.
 */
export const amountGivenSchema = z.string().trim().max(100).nullable().default(null);

/**
 * The charted dose, and what was actually given when that was written down and
 * differs from it. One implementation so the chart, the history and the PDF
 * all say it the same way.
 */
export function describeAmountGiven(charted: string, amountGiven: string | null): string {
  const given = (amountGiven ?? '').trim();
  if (given === '' || given === charted.trim()) return charted;
  return `${charted}, gave ${given}`;
}

export const signOffRequestSchema = z
  .object({
    /** UUID v7 from the device, so a replay updates rather than duplicates. */
    id: z.string().uuid(),
    status: administrationStatusSchema,
    /** When the dose was actually given, which is not when it was typed in. */
    administeredAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    amountGiven: amountGivenSchema,
    note: z.string().trim().max(2000).nullable().default(null),
    witnessedBy: z.string().uuid().nullable().default(null),
  })
  .strict();

export type SignOffRequest = z.infer<typeof signOffRequestSchema>;

/**
 * A PRN dose, which has no scheduled time to hang off.
 *
 * `reason` is required and `outcome` is not. Why a PRN medication was given is
 * known at the moment it is given and is the whole justification for the dose.
 * What it did is often not known for another hour, and a mandatory outcome
 * field would be filled in with a guess, which is worse than an empty one that
 * can be added to later.
 */
export const recordPrnRequestSchema = z
  .object({
    id: z.string().uuid(),
    medicationId: z.string().uuid(),
    status: administrationStatusSchema,
    administeredAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    amountGiven: amountGivenSchema,
    reason: z.string().trim().min(1).max(2000),
    outcome: z.string().trim().max(2000).nullable().default(null),
    note: z.string().trim().max(2000).nullable().default(null),
    witnessedBy: z.string().uuid().nullable().default(null),
  })
  .strict();

export type RecordPrnRequest = z.infer<typeof recordPrnRequestSchema>;

/** Adding the outcome once it is known. The rest of the record is fixed. */
export const updateAdministrationRequestSchema = z
  .object({ outcome: z.string().trim().max(2000).nullable() })
  .strict();

export type UpdateAdministrationRequest = z.infer<typeof updateAdministrationRequestSchema>;

export const medicationAdministrationSchema = z.object({
  id: z.string(),
  /** Null for a PRN dose, which answers no scheduled time. */
  doseId: z.string().nullable(),
  medicationId: z.string(),
  participantId: z.string(),
  medicationName: z.string(),
  dose: z.string(),
  isPrn: z.boolean(),
  status: administrationStatusSchema,
  administeredAt: z.string(),
  recordedAt: z.string(),
  receivedAt: z.string(),
  /** What was actually given. Null when the worker did not say. */
  amountGiven: z.string().nullable(),
  note: z.string().nullable(),
  reason: z.string().nullable(),
  outcome: z.string().nullable(),
  isLate: z.boolean(),
  recordedBy: z.string().nullable(),
  recordedByName: z.string().nullable(),
  witnessedBy: z.string().nullable(),
  witnessedByName: z.string().nullable(),
});

export type MedicationAdministration = z.infer<typeof medicationAdministrationSchema>;

/* --------------------------------------------------------------- summary */

export const doseCountsSchema = z.object({
  expected: z.number(),
  given: z.number(),
  givenLate: z.number(),
  refused: z.number(),
  withheld: z.number(),
  selfAdministered: z.number(),
  notRequired: z.number(),
  pending: z.number(),
  missed: z.number(),
  notExpected: z.number(),
});

export type DoseCounts = {
  /** Doses the team was there for. The denominator. */
  expected: number;
  given: number;
  givenLate: number;
  refused: number;
  withheld: number;
  selfAdministered: number;
  /** Signed off as not required by the person there. */
  notRequired: number;
  /** Still inside the grace period. */
  pending: number;
  missed: number;
  /** Coverage said the team was not there. Never in the denominator. */
  notExpected: number;
};

function emptyCounts(): DoseCounts {
  return {
    expected: 0,
    given: 0,
    givenLate: 0,
    refused: 0,
    withheld: 0,
    selfAdministered: 0,
    notRequired: 0,
    pending: 0,
    missed: 0,
    notExpected: 0,
  };
}

/**
 * Counts a set of doses, on the same terms as check compliance: coverage
 * decides the denominator, the status decides the column, and a dose still
 * inside its grace period is its own column so every row adds up.
 */
export function countDoses(
  doses: readonly { status: DoseStatus; expected: boolean; isLate: boolean }[],
): DoseCounts {
  const counts = emptyCounts();

  for (const dose of doses) {
    if (!doseCountsTowardCompliance(dose)) {
      counts.notExpected += 1;
      continue;
    }
    counts.expected += 1;

    switch (dose.status) {
      case 'given':
        counts.given += 1;
        if (dose.isLate) counts.givenLate += 1;
        break;
      case 'refused':
        counts.refused += 1;
        break;
      case 'withheld':
        counts.withheld += 1;
        break;
      case 'self_administered':
        counts.selfAdministered += 1;
        break;
      case 'not_required':
        counts.notRequired += 1;
        break;
      case 'pending':
        counts.pending += 1;
        break;
      case 'missed':
        counts.missed += 1;
        break;
    }
  }

  return counts;
}

/**
 * The share of expected doses that were answered at all, signed off either way.
 *
 * Null when nothing was expected, for the same reason the check report has no
 * percentage for a period with nothing scheduled (D51): printing 100 percent
 * for a week the team was not there flatters exactly the periods that deserve a
 * question.
 */
export function signedOffPercent(counts: DoseCounts): number | null {
  if (counts.expected === 0) return null;
  const answered = counts.expected - counts.pending - counts.missed;
  return Math.round((answered / counts.expected) * 100);
}

/* ------------------------------------------------------------- retention */

/** How far ahead doses are materialised, matching the check grid horizon. */
export const MEDICATION_HORIZON_DAYS = 7;
