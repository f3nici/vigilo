import {
  alertSchema,
  apiErrorSchema,
  assignmentSchema,
  clockSkewMs,
  emergencyContactSchema,
  emergencyPlanSchema,
  healthResponseSchema,
  participantDetailSchema,
  participantSummarySchema,
  loginResponseSchema,
  meResponseSchema,
  readyResponseSchema,
  totpEnrolResponseSchema,
  userSummarySchema,
  type CreateAlertRequest,
  type CreateAssignmentRequest,
  type CreateContactRequest,
  type CreateParticipantRequest,
  type EmergencyContact,
  type EmergencyPlan,
  type ErrorCode,
  type HealthResponse,
  type IssuedCredential,
  type LoginResponse,
  type MeResponse,
  type ParticipantAlert,
  type ParticipantAssignment,
  type ParticipantDetail,
  type ParticipantSummary,
  type PutEmergencyPlanRequest,
  type ReadyResponse,
  type TotpEnrolResponse,
  type UpdateAlertRequest,
  type UpdateContactRequest,
  type UpdateParticipantRequest,
  type UserSummary,
} from '@vigilo/shared';
import { z } from 'zod';

/** An error the API returned in the documented envelope (doc 04 §1). */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Last measured device clock skew, positive when the device is ahead. */
let lastSkewMs = 0;

export function getClockSkewMs(): number {
  return lastSkewMs;
}

/**
 * Double-submit CSRF (doc 02 §5). The API sets a readable cookie at sign-in
 * and expects it echoed back as a header on every mutation.
 */
function csrfToken(): string {
  const match = /(?:^|;\s*)vigilo_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

type RequestOptions = {
  method?: string;
  body?: unknown;
};

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = csrfToken();
  }

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const serverTime = response.headers.get('X-Server-Time');
  if (serverTime) {
    lastSkewMs = clockSkewMs(new Date(), new Date(serverTime));
  }

  if (response.status === 204) return null;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(code, message, details);
    }
    throw new ApiRequestError('server_error', 'Something went wrong. Please try again.');
  }

  return body;
}

// Health, outside /v1 and outside auth.
export async function getHealth(): Promise<HealthResponse> {
  return healthResponseSchema.parse(await request('/health'));
}

export async function getReady(): Promise<ReadyResponse> {
  return readyResponseSchema.parse(await request('/ready'));
}

// Auth.
export async function login(email: string, password: string): Promise<LoginResponse> {
  return loginResponseSchema.parse(
    await request('/v1/auth/login', { method: 'POST', body: { email, password } }),
  );
}

export async function submitTotp(challengeId: string, code: string): Promise<LoginResponse> {
  return loginResponseSchema.parse(
    await request('/v1/auth/totp', { method: 'POST', body: { challengeId, code } }),
  );
}

export async function submitRecoveryCode(
  challengeId: string,
  code: string,
): Promise<LoginResponse> {
  return loginResponseSchema.parse(
    await request('/v1/auth/recovery-code', { method: 'POST', body: { challengeId, code } }),
  );
}

export async function getMe(): Promise<MeResponse> {
  return meResponseSchema.parse(await request('/v1/auth/me'));
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/v1/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

export async function beginTotpEnrolment(): Promise<TotpEnrolResponse> {
  return totpEnrolResponseSchema.parse(await request('/v1/auth/totp/enrol', { method: 'POST' }));
}

export async function confirmTotpEnrolment(code: string): Promise<void> {
  await request('/v1/auth/totp/confirm', { method: 'POST', body: { code } });
}

export async function logout(): Promise<void> {
  await request('/v1/auth/logout', { method: 'POST' });
}

// Users, admin only.
const userListSchema = z.object({ users: z.array(userSummarySchema) });
const userWrapperSchema = z.object({ user: userSummarySchema });
const issuedCredentialSchema = z.object({
  user: userSummarySchema,
  oneTimePassword: z.string(),
});

export async function listUsers(): Promise<UserSummary[]> {
  return userListSchema.parse(await request('/v1/users')).users;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  role: string;
}): Promise<IssuedCredential> {
  return issuedCredentialSchema.parse(await request('/v1/users', { method: 'POST', body: input }));
}

export async function resetUserPassword(id: string): Promise<IssuedCredential> {
  return issuedCredentialSchema.parse(
    await request(`/v1/users/${id}/reset-password`, { method: 'POST' }),
  );
}

async function userAction(id: string, action: string): Promise<UserSummary> {
  return userWrapperSchema.parse(await request(`/v1/users/${id}/${action}`, { method: 'POST' }))
    .user;
}

export const suspendUser = (id: string) => userAction(id, 'suspend');
export const reinstateUser = (id: string) => userAction(id, 'reinstate');
export const resetUserTotp = (id: string) => userAction(id, 'reset-totp');
export const unlockUser = (id: string) => userAction(id, 'unlock');

const assignmentListSchema = z.object({ assignments: z.array(assignmentSchema) });

export async function listUserAssignments(id: string): Promise<ParticipantAssignment[]> {
  return assignmentListSchema.parse(await request(`/v1/users/${id}/assignments`)).assignments;
}

// Participants, scoped.
const participantListSchema = z.object({ participants: z.array(participantSummarySchema) });
const participantWrapperSchema = z.object({ participant: participantSummarySchema });
const participantDetailWrapperSchema = z.object({ participant: participantDetailSchema });
const alertWrapperSchema = z.object({ alert: alertSchema });
const contactWrapperSchema = z.object({ contact: emergencyContactSchema });
const planWrapperSchema = z.object({ emergencyPlan: emergencyPlanSchema });

export async function listParticipants(
  options: { includeArchived?: boolean } = {},
): Promise<ParticipantSummary[]> {
  const query = options.includeArchived ? '?includeArchived=true' : '';
  return participantListSchema.parse(await request(`/v1/participants${query}`)).participants;
}

export async function getParticipant(id: string): Promise<ParticipantDetail> {
  return participantDetailWrapperSchema.parse(await request(`/v1/participants/${id}`)).participant;
}

export async function createParticipant(
  input: CreateParticipantRequest,
): Promise<ParticipantSummary> {
  return participantWrapperSchema.parse(
    await request('/v1/participants', { method: 'POST', body: input }),
  ).participant;
}

export async function updateParticipant(
  id: string,
  input: UpdateParticipantRequest,
): Promise<ParticipantSummary> {
  return participantWrapperSchema.parse(
    await request(`/v1/participants/${id}`, { method: 'PATCH', body: input }),
  ).participant;
}

export async function archiveParticipant(id: string): Promise<ParticipantSummary> {
  return participantWrapperSchema.parse(
    await request(`/v1/participants/${id}/archive`, { method: 'POST' }),
  ).participant;
}

export async function restoreParticipant(id: string): Promise<ParticipantSummary> {
  return participantWrapperSchema.parse(
    await request(`/v1/participants/${id}/restore`, { method: 'POST' }),
  ).participant;
}

/** Exact match on the NDIS blind index. Null when nobody has that number. */
export async function lookupByNdisNumber(ndis: string): Promise<ParticipantSummary | null> {
  const body = z
    .object({ participant: participantSummarySchema.nullable() })
    .parse(await request(`/v1/participants/lookup?ndis=${encodeURIComponent(ndis)}`));
  return body.participant;
}

export async function createAlert(
  participantId: string,
  input: CreateAlertRequest,
): Promise<ParticipantAlert> {
  return alertWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/alerts`, { method: 'POST', body: input }),
  ).alert;
}

export async function updateAlert(
  participantId: string,
  alertId: string,
  input: UpdateAlertRequest,
): Promise<ParticipantAlert> {
  return alertWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/alerts/${alertId}`, {
      method: 'PATCH',
      body: input,
    }),
  ).alert;
}

export async function deactivateAlert(
  participantId: string,
  alertId: string,
): Promise<ParticipantAlert> {
  return alertWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/alerts/${alertId}`, { method: 'DELETE' }),
  ).alert;
}

export async function createContact(
  participantId: string,
  input: CreateContactRequest,
): Promise<EmergencyContact> {
  return contactWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/contacts`, { method: 'POST', body: input }),
  ).contact;
}

export async function updateContact(
  participantId: string,
  contactId: string,
  input: UpdateContactRequest,
): Promise<EmergencyContact> {
  return contactWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/contacts/${contactId}`, {
      method: 'PATCH',
      body: input,
    }),
  ).contact;
}

export async function deleteContact(participantId: string, contactId: string): Promise<void> {
  await request(`/v1/participants/${participantId}/contacts/${contactId}`, { method: 'DELETE' });
}

export async function putEmergencyPlan(
  participantId: string,
  input: PutEmergencyPlanRequest,
): Promise<EmergencyPlan> {
  return planWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/emergency-plan`, {
      method: 'PUT',
      body: input,
    }),
  ).emergencyPlan;
}

export async function listAssignments(participantId: string): Promise<ParticipantAssignment[]> {
  return assignmentListSchema.parse(await request(`/v1/participants/${participantId}/assignments`))
    .assignments;
}

export async function grantAssignment(
  participantId: string,
  input: CreateAssignmentRequest,
): Promise<ParticipantAssignment> {
  return z.object({ assignment: assignmentSchema }).parse(
    await request(`/v1/participants/${participantId}/assignments`, {
      method: 'POST',
      body: input,
    }),
  ).assignment;
}

export async function revokeAssignment(assignmentId: string): Promise<ParticipantAssignment> {
  return z
    .object({ assignment: assignmentSchema })
    .parse(await request(`/v1/assignments/${assignmentId}`, { method: 'DELETE' })).assignment;
}
