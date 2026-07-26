import { describe, expect, it } from 'vitest';
import { checkPassword, isPasswordAcceptable, MIN_PASSWORD_LENGTH } from './password.js';

describe('checkPassword', () => {
  it('accepts a reasonable password', () => {
    expect(checkPassword({ password: 'correct horse battery staple' })).toEqual([]);
  });

  it('rejects anything under the minimum length', () => {
    expect(checkPassword({ password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) })).toContain('too_short');
  });

  it('rejects a known common password', () => {
    expect(checkPassword({ password: 'passwordpassword' })).toContain('compromised');
  });

  it('ignores case and surrounding space when matching the common list', () => {
    expect(checkPassword({ password: '  PasswordPassword  ' })).toContain('compromised');
  });

  it('rejects a password containing the email local part', () => {
    expect(checkPassword({ password: 'josmith-is-here', email: 'josmith@example.org' })).toContain(
      'contains_email',
    );
  });

  it('ignores a very short email local part, which would reject too much', () => {
    expect(
      checkPassword({ password: 'joyful mountain range', email: 'jo@example.org' }),
    ).not.toContain('contains_email');
  });

  it('rejects reusing the current password', () => {
    expect(
      checkPassword({ password: 'the same one again', currentPassword: 'the same one again' }),
    ).toContain('not_new');
  });

  it('reports every problem at once rather than one at a time', () => {
    const problems = checkPassword({ password: 'admin', email: 'admin@example.org' });
    expect(problems).toContain('too_short');
    expect(problems).toContain('compromised');
  });
});

describe('isPasswordAcceptable', () => {
  it('agrees with checkPassword', () => {
    expect(isPasswordAcceptable({ password: 'a long enough passphrase' })).toBe(true);
    expect(isPasswordAcceptable({ password: 'short' })).toBe(false);
  });
});
