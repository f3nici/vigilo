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
