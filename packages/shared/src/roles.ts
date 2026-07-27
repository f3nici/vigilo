import { z } from 'zod';

/**
 * Five roles, and a user has exactly one (doc 01 §3).
 */
export const roles = ['admin', 'team_leader', 'nurse', 'worker', 'participant'] as const;

export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;

export const userStatuses = ['active', 'suspended', 'archived'] as const;
export const userStatusSchema = z.enum(userStatuses);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * TOTP is required for admin, team leader and nurse, optional for workers
 * (doc 01 §10). A participant self-access account is not required to enrol.
 */
export function totpRequired(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

/** Only a participant account is tied to a participant record (doc 03 §2). */
export function requiresParticipantId(role: Role): boolean {
  return role === 'participant';
}

/**
 * Who may administer accounts. Team leaders grant participant access but never
 * create users, and only an admin creates another admin (doc 01 §3).
 */
export function canAdministerUsers(role: Role): boolean {
  return role === 'admin';
}

/**
 * Who may do what to a participant record (doc 01 §3.6). These are role
 * capabilities only: being allowed to edit an alert says nothing about whether
 * this participant is in your scope, which the scope resolver answers
 * separately. Both checks apply, always.
 */
export function canManageParticipants(role: Role): boolean {
  return role === 'admin';
}

/** A nurse maintains clinical flags, so alerts are not admin-only. */
export function canEditAlerts(role: Role): boolean {
  return role === 'admin' || role === 'nurse';
}

export function canEditContacts(role: Role): boolean {
  return role === 'admin';
}

export function canWriteEmergencyPlan(role: Role): boolean {
  return role === 'admin' || role === 'nurse';
}

/**
 * A team leader grants access within their own scope, to cover a shift. There
 * is no self-service break-glass: nobody grants themselves anything
 * (doc 01 §4.1).
 */
export function canGrantAccess(role: Role): boolean {
  return role === 'admin' || role === 'team_leader';
}
