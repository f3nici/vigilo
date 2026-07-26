import { commonPasswords } from './common-passwords.js';

/**
 * Password policy (doc 07 §3). Lives in shared so the sign-in screen can show
 * the same failures the server will enforce, rather than a round trip per
 * keystroke of guesswork.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordProblem =
  'too_short' | 'too_long' | 'compromised' | 'contains_email' | 'not_new';

export type PasswordCheckInput = {
  password: string;
  /** Rejected if the password contains the local part of the user's email. */
  email?: string | undefined;
  /** Rejected if it matches the password being replaced. */
  currentPassword?: string | undefined;
};

/**
 * Normalisation for the compromised-password check only. Never applied to the
 * password that gets hashed.
 */
function normalise(password: string): string {
  return password.trim().toLowerCase();
}

export function checkPassword(input: PasswordCheckInput): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const { password, email, currentPassword } = input;

  if (password.length < MIN_PASSWORD_LENGTH) problems.push('too_short');
  if (password.length > MAX_PASSWORD_LENGTH) problems.push('too_long');

  if (commonPasswords.has(normalise(password))) problems.push('compromised');

  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase() ?? '';
    if (localPart.length >= 3 && normalise(password).includes(localPart)) {
      problems.push('contains_email');
    }
  }

  if (currentPassword !== undefined && password === currentPassword) {
    problems.push('not_new');
  }

  return problems;
}

export function isPasswordAcceptable(input: PasswordCheckInput): boolean {
  return checkPassword(input).length === 0;
}

/** Plain Australian English, shown straight to the user (doc 08 §7). */
export const passwordProblemMessages: Record<PasswordProblem, string> = {
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  too_long: `Use no more than ${MAX_PASSWORD_LENGTH} characters.`,
  compromised: 'That password appears in lists of known passwords. Pick another.',
  contains_email: 'Do not use your email address in your password.',
  not_new: 'Pick a password you have not used here before.',
};
