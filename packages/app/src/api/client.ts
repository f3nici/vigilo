import {
  apiErrorSchema,
  clockSkewMs,
  healthResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  readyResponseSchema,
  totpEnrolResponseSchema,
  userSummarySchema,
  type ErrorCode,
  type HealthResponse,
  type IssuedCredential,
  type LoginResponse,
  type MeResponse,
  type ReadyResponse,
  type TotpEnrolResponse,
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

// Participants, scoped. Phase 2 fleshes this out.
const participantListSchema = z.object({
  participants: z.array(z.object({ id: z.string(), status: z.string() })),
});

export async function listParticipants() {
  return participantListSchema.parse(await request('/v1/participants')).participants;
}
