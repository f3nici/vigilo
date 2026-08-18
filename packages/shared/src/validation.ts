import type { ZodIssue } from 'zod';

/**
 * Turning a Zod failure into something a support worker can act on.
 *
 * Zod's own messages are written for the developer reading a stack trace:
 * "password: String must contain at least 1 character(s)" told somebody who
 * had left the password box empty nothing they could use. Every validation
 * failure in the product goes through here, on the server before it becomes an
 * API error and on the device before it is shown beside a field, so the same
 * mistake reads the same way wherever it is caught.
 *
 * A message an author wrote by hand is left exactly as it is. Those are
 * already plain English and they know things this file cannot, so this only
 * ever replaces the ones Zod generated (doc 08 §7).
 */

/**
 * Zod's own generated messages, which are the ones worth replacing.
 *
 * Matching the text rather than the issue code, because Zod puts the author's
 * message in the same field as its own and there is nothing else to tell them
 * apart. A pattern that is too greedy costs a hand-written message; that is
 * why each of these is anchored and shaped like the template it comes from.
 */
const ZOD_GENERATED = [
  /^Required$/,
  /^Expected .+, received .+$/,
  /^Invalid$/,
  /^Invalid input$/,
  /^Invalid input: must .+$/,
  /^Invalid literal value/,
  /^Invalid discriminator value/,
  /^Invalid enum value/,
  /^Invalid date$/,
  /^Invalid function arguments$/,
  /^Invalid function return type$/,
  /^Invalid [a-z0-9]+$/,
  /^Unrecognized key/,
  /^String must contain/,
  /^Number must be/,
  /^BigInt must be/,
  /^Array must contain/,
  /^Set must contain/,
  /^Date must be/,
];

function isGenerated(message: string): boolean {
  return ZOD_GENERATED.some((pattern) => pattern.test(message));
}

/** Words that are not capitalised by spelling them out. */
const ACRONYMS: Record<string, string> = {
  ndis: 'NDIS',
  totp: 'TOTP',
  prn: 'PRN',
  pin: 'PIN',
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  csv: 'CSV',
  pdf: 'PDF',
  sms: 'SMS',
  api: 'API',
};

/** Keys whose spelled-out form reads badly or says the wrong thing. */
const FIELD_NAMES: Record<string, string> = {
  dob: 'Date of birth',
  email: 'Email address',
  totpCode: 'Authentication code',
  reasonCodeId: 'Reason',
  templateVersionId: 'Check form',
  participantId: 'Participant',
  categoryId: 'Category',
  occurredAt: 'The date it happened',
  recordedAt: 'The time it was recorded',
  body: 'What you wrote',
  note: 'Note',
};

function words(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The name of the field, as the person filling it in would say it.
 *
 * The last part of the path, because that is the field itself: a failure at
 * `values.2.number` is about a number somebody typed, and telling them the
 * index helps nobody standing in a hallway with a phone.
 */
export function fieldLabel(path: readonly (string | number)[]): string {
  const key = [...path].reverse().find((part) => typeof part === 'string');
  if (key === undefined) return 'That value';

  const named = FIELD_NAMES[key];
  if (named !== undefined) return named;

  const spelled = words(key)
    .split(' ')
    .map((word) => ACRONYMS[word] ?? word);

  const [first = '', ...rest] = spelled;
  const head = ACRONYMS[first.toLowerCase()] ?? first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(' ');
}

function lower(label: string): string {
  // "NDIS number" keeps its capitals; "New password" does not.
  return /^[A-Z]{2,}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

function tooSmall(issue: Extract<ZodIssue, { code: 'too_small' }>, label: string): string {
  const minimum = Number(issue.minimum);

  if (issue.type === 'string') {
    if (minimum <= 1) return `${label} is required.`;
    if (issue.exact === true) return `${label} has to be exactly ${minimum} characters.`;
    return `${label} needs at least ${minimum} characters.`;
  }

  if (issue.type === 'array' || issue.type === 'set') {
    if (minimum <= 1) return `Choose at least one ${lower(label)}.`;
    return `Choose at least ${minimum}.`;
  }

  if (issue.type === 'date') return `${label} is too early.`;

  if (issue.exact === true) return `${label} has to be ${minimum}.`;
  return issue.inclusive
    ? `${label} must be ${minimum} or more.`
    : `${label} must be over ${minimum}.`;
}

function tooBig(issue: Extract<ZodIssue, { code: 'too_big' }>, label: string): string {
  const maximum = Number(issue.maximum);

  if (issue.type === 'string') {
    if (issue.exact === true) return `${label} has to be exactly ${maximum} characters.`;
    return `${label} cannot be longer than ${maximum} characters.`;
  }

  if (issue.type === 'array' || issue.type === 'set') {
    return `Choose no more than ${maximum}.`;
  }

  if (issue.type === 'date') return `${label} is too late.`;

  if (issue.exact === true) return `${label} has to be ${maximum}.`;
  return issue.inclusive
    ? `${label} must be ${maximum} or less.`
    : `${label} must be under ${maximum}.`;
}

function badString(issue: Extract<ZodIssue, { code: 'invalid_string' }>, label: string): string {
  if (issue.validation === 'email') return 'Enter a valid email address.';
  if (issue.validation === 'url') return 'Enter a valid web address.';
  if (issue.validation === 'datetime') return `${label} is not a date and time Vigilo can read.`;
  if (issue.validation === 'date') return `${label} is not a date Vigilo can read.`;
  if (issue.validation === 'time') return `${label} is not a time Vigilo can read.`;
  if (issue.validation === 'uuid' || issue.validation === 'cuid' || issue.validation === 'ulid') {
    return `${label} is not one Vigilo recognises.`;
  }
  return `${label} is not in the right format.`;
}

/** A list, said the way a person would say it out loud. */
function options(values: readonly (string | number)[]): string {
  const shown = values.map(String);
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1] ?? ''}`;
}

/** One Zod failure, in plain Australian English. */
export function describeIssue(issue: ZodIssue): string {
  if (!isGenerated(issue.message)) return issue.message;

  const label = fieldLabel(issue.path);

  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null'
        ? `${label} is required.`
        : `${label} is not in a form Vigilo can read.`;

    case 'too_small':
      return tooSmall(issue, label);

    case 'too_big':
      return tooBig(issue, label);

    case 'invalid_string':
      return badString(issue, label);

    case 'invalid_enum_value':
      return `${label} has to be ${options(issue.options)}.`;

    case 'invalid_union_discriminator':
      return `${label} has to be ${options(issue.options.map(String))}.`;

    case 'invalid_date':
      return `${label} is not a date Vigilo can read.`;

    case 'not_multiple_of':
      return `${label} has to be a multiple of ${String(issue.multipleOf)}.`;

    case 'not_finite':
      return `${label} has to be a number.`;

    case 'unrecognized_keys':
      // Not something anybody typed: a client sent a field the schema does not
      // have, which is a bug in the app rather than a mistake by the user.
      return 'Vigilo did not understand part of that request. Try again, and update the app if it keeps happening.';

    default:
      return `${label} is not valid.`;
  }
}

/**
 * The one failure to lead with.
 *
 * The first, in the order the schema declares its fields, which is the order
 * they appear on screen. A wall of every problem at once is how a form stops
 * being read at all.
 */
export function describeIssues(issues: readonly ZodIssue[]): string {
  const first = issues[0];
  return first === undefined ? 'That is not something Vigilo can save.' : describeIssue(first);
}

/** Every failure, keyed by the field it belongs to, for a form that marks them. */
export function issuesByField(issues: readonly ZodIssue[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.find((part) => typeof part === 'string');
    if (typeof key !== 'string' || found[key] !== undefined) continue;
    found[key] = describeIssue(issue);
  }
  return found;
}
