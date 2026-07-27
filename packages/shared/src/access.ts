import type { Role } from './roles.js';

/**
 * Effective participant access (doc 03 §2).
 *
 * This lives in shared because the API scope layer and the sync scope
 * calculation must agree exactly. If the server and the device can disagree
 * about who may see whom, that is a bug, and a serious one.
 */

export type AssignmentKind = 'standing' | 'temporary';

export type Assignment = {
  participantId: string;
  kind: AssignmentKind;
  /** Set when the grant has been revoked. */
  revokedAt: Date | null;
  /** Required on a temporary grant, always null on a standing one. */
  expiresAt: Date | null;
};

/** A team leader's or nurse's oversight of a participant. */
export type TeamScope = {
  participantId: string;
  revokedAt: Date | null;
};

/**
 * Standing rows not revoked, plus temporary rows not revoked and not expired.
 * Expiry is exclusive: a grant expiring at 17:00 does not cover 17:00.
 */
export function isAssignmentEffective(assignment: Assignment, now: Date): boolean {
  if (assignment.revokedAt !== null && assignment.revokedAt <= now) return false;
  if (assignment.kind === 'standing') return true;
  if (assignment.expiresAt === null) return false;
  return assignment.expiresAt > now;
}

export function effectiveAssignedParticipantIds(
  assignments: readonly Assignment[],
  now: Date,
): string[] {
  const ids = new Set<string>();
  for (const assignment of assignments) {
    if (isAssignmentEffective(assignment, now)) ids.add(assignment.participantId);
  }
  return [...ids];
}

export function effectiveTeamScopeParticipantIds(
  scopes: readonly TeamScope[],
  now: Date,
): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (scope.revokedAt === null || scope.revokedAt > now) ids.add(scope.participantId);
  }
  return [...ids];
}

/**
 * What a principal may touch.
 *
 * `all` is admin only. Everyone else gets an explicit id list, and an empty
 * list is a real answer meaning "nothing", not an error.
 */
export type Scope = { kind: 'all' } | { kind: 'ids'; participantIds: string[] };

export type ScopeInput = {
  role: Role;
  /** Set only when the role is `participant`. */
  ownParticipantId: string | null;
  assignments: readonly Assignment[];
  teamScopes: readonly TeamScope[];
};

/**
 * The single place the access rules live.
 *
 * - admin sees everything
 * - team leader and nurse see their team scope plus anything assigned to them
 * - worker sees only effective assignments
 * - participant sees only themselves
 */
export function resolveScope(input: ScopeInput, now: Date): Scope {
  if (input.role === 'admin') return { kind: 'all' };

  if (input.role === 'participant') {
    return {
      kind: 'ids',
      participantIds: input.ownParticipantId === null ? [] : [input.ownParticipantId],
    };
  }

  const assigned = effectiveAssignedParticipantIds(input.assignments, now);

  if (input.role === 'team_leader' || input.role === 'nurse') {
    const overseen = effectiveTeamScopeParticipantIds(input.teamScopes, now);
    return { kind: 'ids', participantIds: [...new Set([...overseen, ...assigned])] };
  }

  return { kind: 'ids', participantIds: assigned };
}

export function scopeAllows(scope: Scope, participantId: string): boolean {
  if (scope.kind === 'all') return true;
  return scope.participantIds.includes(participantId);
}

/**
 * Incidents are never visible to a participant self-access account, enforced
 * in the scope layer rather than only in the UI (doc 03 §9). The entity list
 * grows as later phases add tables.
 */
export type RestrictedEntity = 'incident';

export function roleCanSeeEntity(role: Role, entity: RestrictedEntity): boolean {
  if (entity === 'incident') return role !== 'participant';
  return true;
}
