import { describe, expect, it } from 'vitest';
import {
  compareParticipants,
  createAssignmentRequestSchema,
  createParticipantRequestSchema,
  isoDateSchema,
  matchesParticipantSearch,
  ndisNumberSchema,
  normaliseNdisNumber,
  participantDisplayName,
  participantShortName,
  updateParticipantRequestSchema,
  type ParticipantSummary,
} from './participants.js';

const valid = {
  firstName: 'Alice',
  lastName: 'Smith',
  dateOfBirth: '1994-03-02',
  ndisNumber: '431234567',
};

describe('NDIS numbers', () => {
  it('strips the spacing people actually type', () => {
    expect(normaliseNdisNumber(' 431 234 567 ')).toBe('431234567');
    expect(normaliseNdisNumber('431-234-567')).toBe('431234567');
  });

  it('normalises before validating, so a spaced number is accepted', () => {
    expect(ndisNumberSchema.parse('431 234 567')).toBe('431234567');
  });

  it('rejects anything that is not nine digits', () => {
    expect(ndisNumberSchema.safeParse('43123456').success).toBe(false);
    expect(ndisNumberSchema.safeParse('4312345678').success).toBe(false);
    expect(ndisNumberSchema.safeParse('43123456x').success).toBe(false);
  });
});

describe('dates of birth', () => {
  it('accepts a real date', () => {
    expect(isoDateSchema.parse('2000-02-29')).toBe('2000-02-29');
  });

  it('rejects a date that does not exist', () => {
    expect(isoDateSchema.safeParse('2001-02-29').success).toBe(false);
    expect(isoDateSchema.safeParse('1994-13-01').success).toBe(false);
  });

  it('rejects a format nobody can parse unambiguously', () => {
    expect(isoDateSchema.safeParse('02/03/1994').success).toBe(false);
  });
});

describe('creating a participant', () => {
  it('accepts the minimum a record needs', () => {
    const parsed = createParticipantRequestSchema.parse(valid);
    expect(parsed.firstName).toBe('Alice');
    expect(parsed.preferredName).toBeUndefined();
  });

  it('trims the whitespace a hurried admin leaves behind', () => {
    const parsed = createParticipantRequestSchema.parse({ ...valid, firstName: '  Alice  ' });
    expect(parsed.firstName).toBe('Alice');
  });

  it('requires a name', () => {
    expect(createParticipantRequestSchema.safeParse({ ...valid, firstName: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses an update that changes nothing', () => {
    expect(updateParticipantRequestSchema.safeParse({}).success).toBe(false);
    expect(updateParticipantRequestSchema.safeParse({ phone: '0400 000 000' }).success).toBe(true);
  });
});

describe('assignment requests', () => {
  const userId = '5b1f1b1e-0000-4000-8000-000000000001';

  it('accepts a standing grant with nothing else', () => {
    expect(createAssignmentRequestSchema.safeParse({ userId, kind: 'standing' }).success).toBe(
      true,
    );
  });

  it('requires an expiry and a reason on a temporary grant', () => {
    expect(createAssignmentRequestSchema.safeParse({ userId, kind: 'temporary' }).success).toBe(
      false,
    );
    expect(
      createAssignmentRequestSchema.safeParse({
        userId,
        kind: 'temporary',
        expiresAt: '2026-07-27T17:00:00+10:00',
      }).success,
    ).toBe(false);
    expect(
      createAssignmentRequestSchema.safeParse({
        userId,
        kind: 'temporary',
        expiresAt: '2026-07-27T17:00:00+10:00',
        reason: 'covering a shift',
      }).success,
    ).toBe(true);
  });

  it('refuses an expiry on a standing grant, which would silently never apply', () => {
    expect(
      createAssignmentRequestSchema.safeParse({
        userId,
        kind: 'standing',
        expiresAt: '2026-07-27T17:00:00+10:00',
        reason: 'covering a shift',
      }).success,
    ).toBe(false);
  });
});

describe('names', () => {
  it('uses the preferred name where there is room for one', () => {
    expect(
      participantDisplayName({ firstName: 'Alice', lastName: 'Smith', preferredName: 'Ali' }),
    ).toBe('Ali Smith');
  });

  it('falls back to the first name', () => {
    expect(
      participantDisplayName({ firstName: 'Alice', lastName: 'Smith', preferredName: null }),
    ).toBe('Alice Smith');
    expect(
      participantDisplayName({ firstName: 'Alice', lastName: 'Smith', preferredName: '  ' }),
    ).toBe('Alice Smith');
  });

  it('reduces to an initial and surname for anything that reaches a lock screen', () => {
    expect(participantShortName({ firstName: 'Alice', lastName: 'Smith' })).toBe('A. Smith');
  });
});

describe('list ordering and search', () => {
  const summary = (
    firstName: string,
    lastName: string,
    preferredName: string | null = null,
  ): ParticipantSummary => ({
    id: '5b1f1b1e-0000-4000-8000-000000000001',
    firstName,
    lastName,
    preferredName,
    status: 'active',
    archivedAt: null,
    access: { kind: 'all', expiresAt: null },
  });

  it('sorts by surname then first name', () => {
    const sorted = [summary('Bob', 'Smith'), summary('Alice', 'Smith'), summary('Zoe', 'Adams')]
      .sort(compareParticipants)
      .map((p) => `${p.firstName} ${p.lastName}`);
    expect(sorted).toEqual(['Zoe Adams', 'Alice Smith', 'Bob Smith']);
  });

  it('matches on any of the three names, case-insensitively', () => {
    const alice = summary('Alice', 'Smith', 'Ali');
    expect(matchesParticipantSearch(alice, 'ali')).toBe(true);
    expect(matchesParticipantSearch(alice, 'SMITH')).toBe(true);
    expect(matchesParticipantSearch(alice, 'nguyen')).toBe(false);
  });

  it('treats an empty query as no filter', () => {
    expect(matchesParticipantSearch(summary('Alice', 'Smith'), '  ')).toBe(true);
  });
});
