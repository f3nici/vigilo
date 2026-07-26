import { and, eq, isNull, or, gt } from 'drizzle-orm';
import {
  resolveScope,
  scopeAllows,
  type Assignment,
  type Role,
  type Scope,
  type TeamScope,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { participantAssignments, teamScopes } from '../db/schema.js';
import { HttpError } from '../middleware/errors.js';

/**
 * The central scope resolver (doc 07 §3, CLAUDE.md).
 *
 * One function maps a principal to the participant ids it may touch. Route
 * handlers never assemble access rules themselves, and every data access goes
 * through here. The rules themselves live in @vigilo/shared, so the API and the
 * device sync cannot drift apart.
 */

export type ScopePrincipal = {
  userId: string;
  role: Role;
  participantId: string | null;
};

export async function resolveScopeFor(
  db: Database,
  principal: ScopePrincipal,
  now = new Date(),
): Promise<Scope> {
  // An admin is not limited to a list, so there is nothing to load.
  if (principal.role === 'admin') {
    return resolveScope(
      { role: principal.role, ownParticipantId: null, assignments: [], teamScopes: [] },
      now,
    );
  }

  if (principal.role === 'participant') {
    return resolveScope(
      {
        role: principal.role,
        ownParticipantId: principal.participantId,
        assignments: [],
        teamScopes: [],
      },
      now,
    );
  }

  const assignmentRows = await db
    .select({
      participantId: participantAssignments.participantId,
      kind: participantAssignments.kind,
      revokedAt: participantAssignments.revokedAt,
      expiresAt: participantAssignments.expiresAt,
    })
    .from(participantAssignments)
    .where(
      and(
        eq(participantAssignments.userId, principal.userId),
        or(isNull(participantAssignments.revokedAt), gt(participantAssignments.revokedAt, now)),
      ),
    );

  const assignments: Assignment[] = assignmentRows.map((row) => ({
    participantId: row.participantId,
    kind: row.kind,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
  }));

  let scopes: TeamScope[] = [];
  if (principal.role === 'team_leader' || principal.role === 'nurse') {
    const scopeRows = await db
      .select({
        participantId: teamScopes.participantId,
        revokedAt: teamScopes.revokedAt,
      })
      .from(teamScopes)
      .where(
        and(
          eq(teamScopes.userId, principal.userId),
          or(isNull(teamScopes.revokedAt), gt(teamScopes.revokedAt, now)),
        ),
      );
    scopes = scopeRows.map((row) => ({
      participantId: row.participantId,
      revokedAt: row.revokedAt,
    }));
  }

  return resolveScope(
    {
      role: principal.role,
      ownParticipantId: principal.participantId,
      assignments,
      teamScopes: scopes,
    },
    now,
  );
}

/**
 * Throws `scope_denied` if the principal may not touch this participant.
 *
 * Deliberately not a 404: the docs are explicit that an out-of-scope request
 * must return `scope_denied` rather than a not-found that leaks existence.
 */
export function assertInScope(scope: Scope, participantId: string): void {
  if (!scopeAllows(scope, participantId)) {
    throw new HttpError('scope_denied', 'You are not assigned to this participant.');
  }
}

export { scopeAllows };
