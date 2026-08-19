import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeIssue, describeIssues, fieldLabel, issuesByField } from './validation.js';
import { loginRequestSchema } from './auth.js';

/**
 * Validation messages a person can act on (#23).
 *
 * The failure that started this: an empty password box answered with
 * "password: String must contain at least 1 character(s)", which is a console
 * line wearing a form's clothes. The two rules under test are that Zod's own
 * wording never reaches a user, and that a message an author wrote by hand is
 * never rewritten, because those know things this translator cannot.
 */

function issuesOf(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('expected that to fail');
  return parsed.error.issues;
}

function messageFor(schema: z.ZodTypeAny, value: unknown): string {
  return describeIssues(issuesOf(schema, value));
}

describe('the message somebody actually reads', () => {
  it('answers an empty password with something to do about it', () => {
    expect(messageFor(loginRequestSchema, { email: 'ana@example.com', password: '' })).toBe(
      'Password is required.',
    );
  });

  it('says a missing field is missing rather than naming a type', () => {
    expect(messageFor(z.object({ displayName: z.string() }), {})).toBe('Display name is required.');
  });

  it('never leaves Zod wording in place', () => {
    const schemas: [z.ZodTypeAny, unknown][] = [
      [z.object({ name: z.string().min(3) }), { name: 'a' }],
      [z.object({ name: z.string().max(3) }), { name: 'abcd' }],
      [z.object({ count: z.number().min(2) }), { count: 1 }],
      [z.object({ count: z.number().max(2) }), { count: 4 }],
      [z.object({ when: z.string().datetime() }), { when: 'yesterday' }],
      [z.object({ id: z.string().uuid() }), { id: 'nope' }],
      [z.object({ role: z.enum(['worker', 'admin']) }), { role: 'boss' }],
      [z.object({ tags: z.array(z.string()).min(1) }), { tags: [] }],
      [z.object({ name: z.string() }).strict(), { name: 'a', extra: 1 }],
      [z.object({ count: z.number() }), { count: 'four' }],
    ];

    for (const [schema, value] of schemas) {
      const message = messageFor(schema, value);
      expect(message).not.toMatch(/String must|Number must|Array must|Expected .+, received/);
      expect(message).not.toMatch(/^Required$|^Invalid/);
      expect(message.endsWith('.')).toBe(true);
    }
  });

  it('keeps a message somebody wrote on purpose', () => {
    expect(messageFor(loginRequestSchema, { email: 'not-an-email', password: 'x' })).toBe(
      'Enter a valid email address.',
    );

    const schema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') });
    expect(messageFor(schema, { code: 'abc' })).toBe('Enter the 6-digit code.');
  });

  it('spells a field the way somebody filling it in would say it', () => {
    expect(fieldLabel(['newPassword'])).toBe('New password');
    expect(fieldLabel(['ndisNumber'])).toBe('NDIS number');
    expect(fieldLabel(['dob'])).toBe('Date of birth');
    // The index says nothing useful to a worker holding a phone.
    expect(fieldLabel(['values', 2, 'number'])).toBe('Number');
    expect(fieldLabel([])).toBe('That value');
  });

  it('says what a choice has to be, in words', () => {
    expect(
      messageFor(z.object({ role: z.enum(['worker', 'lead', 'admin']) }), { role: 'boss' }),
    ).toBe('Role has to be worker, lead or admin.');
  });

  it('gives a form one message per field', () => {
    const schema = z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email('Enter a valid email address.'),
    });

    expect(issuesByField(issuesOf(schema, { firstName: '', lastName: '', email: 'x' }))).toEqual({
      firstName: 'First name is required.',
      lastName: 'Last name is required.',
      email: 'Enter a valid email address.',
    });
  });

  it('has something to say when there is no issue at all', () => {
    expect(describeIssues([])).toBe('That is not something Vigilo can save.');
  });

  it('describes one issue on its own', () => {
    const [issue] = issuesOf(z.object({ note: z.string().min(1) }), { note: '' });
    expect(describeIssue(issue!)).toBe('Note is required.');
  });
});
