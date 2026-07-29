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

/**
 * Checks (doc 01 §3.6).
 *
 * A nurse defines what is recorded and an admin decides when, which is why
 * these two are different lists rather than one "configure checks" permission.
 * Clinical authority and administrative authority are deliberately separate.
 */
export function canManageTemplates(role: Role): boolean {
  return role === 'admin' || role === 'nurse';
}

export function canManageSchedules(role: Role): boolean {
  return role === 'admin' || role === 'team_leader';
}

/** Every staff role records checks. A self-access account reads only. */
export function canRecordChecks(role: Role): boolean {
  return role !== 'participant';
}

/** A worker edits their own entry; changing someone else's needs oversight. */
export function canEditOthersEntries(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

/**
 * Back-fill past the cut-off (default 24 hours) needs a team leader (A6).
 * Without this, a record could be created for any day in the past at any time,
 * which is the difference between a late entry and a fabricated one.
 */
export function canBackfillPastCutoff(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

export function canManageReasonCodes(role: Role): boolean {
  return role === 'admin';
}

/**
 * Medications (doc 01 §7.2).
 *
 * Deciding what a person takes is a clinical judgement, so it sits with the
 * nurse and the admin, exactly where care plan authorship sits. It is
 * deliberately not with the team leader, who sets up when checks happen but
 * does not decide what goes into somebody.
 */
export function canManageMedications(role: Role): boolean {
  return role === 'admin' || role === 'nurse';
}

/**
 * Every staff role signs off a dose, which is the whole point: the person
 * standing there is the person who records it. A self-access account reads its
 * own record and signs off nothing.
 */
export function canSignOffMedication(role: Role): boolean {
  return role !== 'participant';
}

/**
 * A witness is a second staff member confirming the dose, so a self-access
 * account can never be one, whatever the UI offers.
 */
export function canWitnessMedication(role: Role): boolean {
  return role !== 'participant';
}

/**
 * Diary (doc 01 §3.6, §6).
 *
 * Every staff role writes in the diary. A self-access account reads its own
 * visible entries and writes nothing, which is why this is the same shape as
 * `canRecordChecks` rather than a reference to it: they are separate rules that
 * happen to agree today.
 */
export function canRecordDiary(role: Role): boolean {
  return role !== 'participant';
}

/** As with checks, changing what someone else wrote needs oversight. */
export function canEditOthersDiary(role: Role): boolean {
  return role === 'admin' || role === 'team_leader' || role === 'nurse';
}

/**
 * Deleting a diary entry is admin-only and is a soft delete (doc 04 §8).
 * Nothing is hard-deleted while retention applies, so this hides the entry and
 * leaves the record, and it is audited.
 */
export function canDeleteDiary(role: Role): boolean {
  return role === 'admin';
}

export function canManageDiaryCategories(role: Role): boolean {
  return role === 'admin';
}

/**
 * Who decides whether the participant sees an entry.
 *
 * Staff-controlled, per doc 01 §3.7: the person the entry is about cannot
 * change their own visibility flag, or the toggle would mean nothing.
 */
export function canSetDiaryVisibility(role: Role): boolean {
  return role !== 'participant';
}
