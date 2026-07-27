import { describe, expect, it } from 'vitest';
import {
  isAssignmentEffective,
  resolveScope,
  roleCanSeeEntity,
  scopeAllows,
  type Assignment,
  type ScopeInput,
} from './access.js';

const now = new Date('2026-07-26T10:00:00.000Z');

function standing(participantId: string, revokedAt: Date | null = null): Assignment {
  return { participantId, kind: 'standing', revokedAt, expiresAt: null };
}

function temporary(participantId: string, expiresAt: Date | null): Assignment {
  return { participantId, kind: 'temporary', revokedAt: null, expiresAt };
}

function input(overrides: Partial<ScopeInput> = {}): ScopeInput {
  return {
    role: 'worker',
    ownParticipantId: null,
    assignments: [],
    teamScopes: [],
    ...overrides,
  };
}

describe('isAssignmentEffective', () => {
  it('accepts a standing grant that has not been revoked', () => {
    expect(isAssignmentEffective(standing('p1'), now)).toBe(true);
  });

  it('drops a revoked standing grant', () => {
    expect(isAssignmentEffective(standing('p1', new Date('2026-07-26T09:00:00Z')), now)).toBe(
      false,
    );
  });

  it('keeps a temporary grant until it expires', () => {
    expect(isAssignmentEffective(temporary('p1', new Date('2026-07-26T17:00:00Z')), now)).toBe(
      true,
    );
  });

  it('drops a temporary grant once expired', () => {
    expect(isAssignmentEffective(temporary('p1', new Date('2026-07-26T09:00:00Z')), now)).toBe(
      false,
    );
  });

  it('treats expiry as exclusive', () => {
    expect(isAssignmentEffective(temporary('p1', now), now)).toBe(false);
  });

  it('drops a temporary grant with no expiry, which should never be written', () => {
    expect(isAssignmentEffective(temporary('p1', null), now)).toBe(false);
  });
});

describe('resolveScope', () => {
  it('gives an admin everything', () => {
    expect(resolveScope(input({ role: 'admin' }), now)).toEqual({ kind: 'all' });
  });

  it('gives a worker only effective assignments', () => {
    const scope = resolveScope(
      input({
        role: 'worker',
        assignments: [
          standing('p1'),
          standing('p2', new Date('2026-07-01T00:00:00Z')),
          temporary('p3', new Date('2026-07-27T00:00:00Z')),
          temporary('p4', new Date('2026-07-01T00:00:00Z')),
        ],
      }),
      now,
    );
    expect(scope).toEqual({ kind: 'ids', participantIds: ['p1', 'p3'] });
  });

  it('gives a team leader their team scope plus their own assignments', () => {
    const scope = resolveScope(
      input({
        role: 'team_leader',
        teamScopes: [{ participantId: 'p1', revokedAt: null }],
        assignments: [standing('p2')],
      }),
      now,
    );
    expect(scope.kind).toBe('ids');
    expect(scope.kind === 'ids' && scope.participantIds.sort()).toEqual(['p1', 'p2']);
  });

  it('drops a revoked team scope', () => {
    const scope = resolveScope(
      input({
        role: 'nurse',
        teamScopes: [{ participantId: 'p1', revokedAt: new Date('2026-07-01T00:00:00Z') }],
      }),
      now,
    );
    expect(scope).toEqual({ kind: 'ids', participantIds: [] });
  });

  it('gives a participant only themselves, ignoring any stray assignment', () => {
    const scope = resolveScope(
      input({
        role: 'participant',
        ownParticipantId: 'p9',
        assignments: [standing('p1')],
      }),
      now,
    );
    expect(scope).toEqual({ kind: 'ids', participantIds: ['p9'] });
  });

  it('does not deduplicate into a wider scope', () => {
    const scope = resolveScope(
      input({
        role: 'team_leader',
        teamScopes: [{ participantId: 'p1', revokedAt: null }],
        assignments: [standing('p1')],
      }),
      now,
    );
    expect(scope).toEqual({ kind: 'ids', participantIds: ['p1'] });
  });
});

describe('scopeAllows', () => {
  it('lets an admin through for anything', () => {
    expect(scopeAllows({ kind: 'all' }, 'anything')).toBe(true);
  });

  it('denies an id outside the list', () => {
    expect(scopeAllows({ kind: 'ids', participantIds: ['p1'] }, 'p2')).toBe(false);
  });

  it('denies everything for an empty scope', () => {
    expect(scopeAllows({ kind: 'ids', participantIds: [] }, 'p1')).toBe(false);
  });
});

describe('roleCanSeeEntity', () => {
  it('hides incidents from a participant self-access account', () => {
    expect(roleCanSeeEntity('participant', 'incident')).toBe(false);
    expect(roleCanSeeEntity('worker', 'incident')).toBe(true);
    expect(roleCanSeeEntity('admin', 'incident')).toBe(true);
  });
});
