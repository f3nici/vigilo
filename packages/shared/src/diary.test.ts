import { describe, expect, it } from 'vitest';
import {
  OCCURRED_AT_MAX_PAST_DAYS,
  canReadDiaryEntry,
  createDiaryEntryRequestSchema,
  describeVisibility,
  diarySnippet,
  matchesDiarySearch,
  occurredAtProblem,
  updateDiaryEntryRequestSchema,
} from './diary.js';

const NOW = new Date('2026-07-28T02:00:00Z');

function minutesFromNow(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

describe('occurredAtProblem', () => {
  it('accepts something that happened earlier in the shift', () => {
    expect(occurredAtProblem(minutesFromNow(-300), NOW)).toBeNull();
  });

  /** A device four minutes fast is not making a claim about the future. */
  it('allows a little clock skew', () => {
    expect(occurredAtProblem(minutesFromNow(4), NOW)).toBeNull();
    expect(occurredAtProblem(minutesFromNow(60), NOW)).toContain('has not happened yet');
  });

  it('refuses a date far enough back to be a typo or a fabrication', () => {
    const days = (count: number) => minutesFromNow(-count * 24 * 60);
    expect(occurredAtProblem(days(OCCURRED_AT_MAX_PAST_DAYS - 1), NOW)).toBeNull();
    expect(occurredAtProblem(days(OCCURRED_AT_MAX_PAST_DAYS + 1), NOW)).toContain('90 days');
  });
});

describe('createDiaryEntryRequestSchema', () => {
  const valid = {
    id: '018f2b4c-0000-7000-8000-000000000001',
    categoryId: '018f2b4c-0000-7000-8000-000000000002',
    body: 'Assisted with shower, good mood throughout.',
    occurredAt: '2026-07-28T01:40:00Z',
  };

  it('defaults to visible, which is the point of the flag', () => {
    const parsed = createDiaryEntryRequestSchema.parse(valid);
    expect(parsed.visibleToParticipant).toBe(true);
    expect(parsed.attachmentIds).toEqual([]);
  });

  it('needs a body with something in it', () => {
    expect(createDiaryEntryRequestSchema.safeParse({ ...valid, body: '   ' }).success).toBe(false);
  });

  /** The id is device-generated, so a drained outbox replays onto one row. */
  it('needs a client-supplied id', () => {
    const { id: _id, ...withoutId } = valid;
    expect(createDiaryEntryRequestSchema.safeParse(withoutId).success).toBe(false);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(createDiaryEntryRequestSchema.safeParse({ ...valid, mood: 'happy' }).success).toBe(
      false,
    );
  });
});

describe('updateDiaryEntryRequestSchema', () => {
  it('takes one field on its own, so a toggle does not resend the body', () => {
    expect(updateDiaryEntryRequestSchema.parse({ visibleToParticipant: false })).toEqual({
      visibleToParticipant: false,
    });
  });

  it('refuses an edit that changes nothing', () => {
    expect(updateDiaryEntryRequestSchema.safeParse({}).success).toBe(false);
    expect(updateDiaryEntryRequestSchema.safeParse({ reason: 'because' }).success).toBe(false);
  });
});

describe('canReadDiaryEntry', () => {
  const staff = { isParticipantSelf: false, isAdmin: false };
  const self = { isParticipantSelf: true, isAdmin: false };
  const admin = { isParticipantSelf: false, isAdmin: true };

  it('hides an entry marked not visible from the participant only', () => {
    const hidden = { visibleToParticipant: false, deletedAt: null };
    expect(canReadDiaryEntry(hidden, self)).toBe(false);
    expect(canReadDiaryEntry(hidden, staff)).toBe(true);
  });

  it('shows a visible entry to everyone', () => {
    const visible = { visibleToParticipant: true, deletedAt: null };
    expect(canReadDiaryEntry(visible, self)).toBe(true);
    expect(canReadDiaryEntry(visible, staff)).toBe(true);
  });

  /** Soft delete looks like a delete, and the row is still there for retention. */
  it('hides a deleted entry from everyone but an admin', () => {
    const deleted = { visibleToParticipant: true, deletedAt: new Date() };
    expect(canReadDiaryEntry(deleted, staff)).toBe(false);
    expect(canReadDiaryEntry(deleted, self)).toBe(false);
    expect(canReadDiaryEntry(deleted, admin)).toBe(true);
  });
});

describe('describeVisibility', () => {
  it('says it in the words on the toggle', () => {
    expect(describeVisibility(true, 'Alice')).toBe('Alice can see this entry');
    expect(describeVisibility(false, 'Alice')).toBe('Hidden from Alice');
  });
});

describe('diarySnippet', () => {
  it('leaves a short note alone', () => {
    expect(diarySnippet('Good day.')).toBe('Good day.');
  });

  it('collapses the whitespace a text area produces', () => {
    expect(diarySnippet('Line one.\n\n  Line two.')).toBe('Line one. Line two.');
  });

  it('cuts on a word boundary', () => {
    const snippet = diarySnippet('a'.repeat(20) + ' ' + 'b'.repeat(20), 30);
    expect(snippet).toBe(`${'a'.repeat(20)}…`);
  });

  /** One long word has no boundary to cut on, and still has to fit. */
  it('cuts mid-word when there is no boundary', () => {
    expect(diarySnippet('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('matchesDiarySearch', () => {
  it('matches a fragment, because that is what people type', () => {
    expect(matchesDiarySearch('Had a seizure at 14:00', 'seiz')).toBe(true);
    expect(matchesDiarySearch('Had a seizure at 14:00', 'SEIZURE')).toBe(true);
    expect(matchesDiarySearch('Had a seizure at 14:00', 'shower')).toBe(false);
  });
});
