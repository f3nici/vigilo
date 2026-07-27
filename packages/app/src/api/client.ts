import {
  alertSchema,
  apiErrorSchema,
  assignmentSchema,
  checkScheduleSchema,
  checkTemplateSchema,
  checkWindowSchema,
  clockSkewMs,
  coverageExceptionSchema,
  coveragePatternSchema,
  emergencyContactSchema,
  emergencyPlanSchema,
  entryRevisionSchema,
  healthResponseSchema,
  missReasonSchema,
  missedReasonCodeSchema,
  publishPreviewSchema,
  recalculationPreviewSchema,
  schedulePreviewSchema,
  templateVersionSchema,
  windowDetailSchema,
  participantDetailSchema,
  participantSummarySchema,
  loginResponseSchema,
  meResponseSchema,
  readyResponseSchema,
  totpEnrolResponseSchema,
  userSummarySchema,
  type CheckSchedule,
  type CheckTemplate,
  type CheckWindow,
  type CoverageException,
  type CoveragePattern,
  type CreateAlertRequest,
  type CreateAssignmentRequest,
  type CreateContactRequest,
  type CreateCoverageExceptionRequest,
  type CreateParticipantRequest,
  type CreateScheduleRequest,
  type CreateTemplateRequest,
  type EditEntryRequest,
  type EmergencyContact,
  type EmergencyPlan,
  type EntryRevision,
  type ErrorCode,
  type HealthResponse,
  type MissedReasonCode,
  type PreviewScheduleRequest,
  type PublishPreview,
  type PutCoveragePatternRequest,
  type PutEntryRequest,
  type PutMissReasonRequest,
  type PutSegmentsRequest,
  type RecalculateCoverageRequest,
  type RecalculationPreview,
  type SchedulePreview,
  type TemplateSchema,
  type TemplateVersion,
  type UpdateTemplateRequest,
  type WindowDetail,
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

// Check templates (doc 04 §5).
const templateListSchema = z.object({ templates: z.array(checkTemplateSchema) });
const templateWrapperSchema = z.object({ template: checkTemplateSchema });
const versionWrapperSchema = z.object({ version: templateVersionSchema });

export async function listTemplates(includeRetired = false): Promise<CheckTemplate[]> {
  const query = includeRetired ? '?includeRetired=true' : '';
  return templateListSchema.parse(await request(`/v1/check-templates${query}`)).templates;
}

export async function getTemplate(id: string): Promise<CheckTemplate> {
  return templateWrapperSchema.parse(await request(`/v1/check-templates/${id}`)).template;
}

export async function createTemplate(input: CreateTemplateRequest): Promise<CheckTemplate> {
  return templateWrapperSchema.parse(
    await request('/v1/check-templates', { method: 'POST', body: input }),
  ).template;
}

export async function updateTemplate(
  id: string,
  input: UpdateTemplateRequest,
): Promise<CheckTemplate> {
  return templateWrapperSchema.parse(
    await request(`/v1/check-templates/${id}`, { method: 'PATCH', body: input }),
  ).template;
}

export async function listTemplateVersions(id: string): Promise<TemplateVersion[]> {
  return z
    .object({ versions: z.array(templateVersionSchema) })
    .parse(await request(`/v1/check-templates/${id}/versions`)).versions;
}

/** Starts a draft from the published version, or hands back the open one. */
export async function startDraft(templateId: string): Promise<TemplateVersion> {
  return versionWrapperSchema.parse(
    await request(`/v1/check-templates/${templateId}/versions`, { method: 'POST' }),
  ).version;
}

export async function saveDraftSchema(
  versionId: string,
  schema: TemplateSchema,
): Promise<TemplateVersion> {
  return versionWrapperSchema.parse(
    await request(`/v1/check-template-versions/${versionId}`, {
      method: 'PATCH',
      body: { schema },
    }),
  ).version;
}

export async function getPublishPreview(versionId: string): Promise<PublishPreview> {
  return publishPreviewSchema.parse(
    await request(`/v1/check-template-versions/${versionId}/publish-preview`),
  );
}

export async function publishVersion(versionId: string): Promise<TemplateVersion> {
  return versionWrapperSchema.parse(
    await request(`/v1/check-template-versions/${versionId}/publish`, { method: 'POST' }),
  ).version;
}

// Schedules and coverage (doc 04 §6).
const scheduleWrapperSchema = z.object({ schedule: checkScheduleSchema });
const regeneratedSchema = z.object({
  removed: z.number(),
  created: z.number(),
  preserved: z.number(),
});

export async function listSchedules(participantId: string): Promise<CheckSchedule[]> {
  return z
    .object({ schedules: z.array(checkScheduleSchema) })
    .parse(await request(`/v1/participants/${participantId}/schedules`)).schedules;
}

export async function createSchedule(
  participantId: string,
  input: CreateScheduleRequest,
): Promise<CheckSchedule> {
  return scheduleWrapperSchema.parse(
    await request(`/v1/participants/${participantId}/schedules`, { method: 'POST', body: input }),
  ).schedule;
}

/** Saves nothing. Drives the live window preview in the schedule editor. */
export async function previewSchedule(
  participantId: string,
  input: PreviewScheduleRequest,
  scheduleId?: string,
): Promise<SchedulePreview> {
  const query = scheduleId ? `?scheduleId=${scheduleId}` : '';
  return schedulePreviewSchema.parse(
    await request(`/v1/participants/${participantId}/schedules/preview${query}`, {
      method: 'POST',
      body: input,
    }),
  );
}

export async function putSegments(
  scheduleId: string,
  segments: PutSegmentsRequest['segments'],
): Promise<{ schedule: CheckSchedule; regenerated: z.infer<typeof regeneratedSchema> }> {
  return z.object({ schedule: checkScheduleSchema, regenerated: regeneratedSchema }).parse(
    await request(`/v1/schedules/${scheduleId}/segments`, {
      method: 'PUT',
      body: { segments },
    }),
  );
}

export async function endSchedule(scheduleId: string): Promise<CheckSchedule> {
  return z
    .object({ schedule: checkScheduleSchema, regenerated: regeneratedSchema })
    .parse(await request(`/v1/schedules/${scheduleId}`, { method: 'DELETE' })).schedule;
}

export async function getCoveragePattern(participantId: string): Promise<CoveragePattern> {
  return z
    .object({ pattern: coveragePatternSchema })
    .parse(await request(`/v1/participants/${participantId}/coverage-pattern`)).pattern;
}

export async function putCoveragePattern(
  participantId: string,
  ranges: PutCoveragePatternRequest['ranges'],
): Promise<CoveragePattern> {
  return z.object({ pattern: coveragePatternSchema }).parse(
    await request(`/v1/participants/${participantId}/coverage-pattern`, {
      method: 'PUT',
      body: { ranges },
    }),
  ).pattern;
}

export async function listCoverageExceptions(participantId: string): Promise<CoverageException[]> {
  return z
    .object({ exceptions: z.array(coverageExceptionSchema) })
    .parse(await request(`/v1/participants/${participantId}/coverage-exceptions`)).exceptions;
}

export async function createCoverageException(
  participantId: string,
  input: CreateCoverageExceptionRequest,
): Promise<CoverageException> {
  return z.object({ exception: coverageExceptionSchema }).parse(
    await request(`/v1/participants/${participantId}/coverage-exceptions`, {
      method: 'POST',
      body: input,
    }),
  ).exception;
}

export async function deleteCoverageException(id: string): Promise<void> {
  await request(`/v1/coverage-exceptions/${id}`, { method: 'DELETE' });
}

/** Preview by default. Pass apply to commit, which is heavily audited. */
export async function recalculateCoverage(
  participantId: string,
  input: RecalculateCoverageRequest,
): Promise<RecalculationPreview> {
  return recalculationPreviewSchema.parse(
    await request(`/v1/participants/${participantId}/coverage/recalculate`, {
      method: 'POST',
      body: input,
    }),
  );
}

// Windows and entries (doc 04 §7).
const windowListSchema = z.object({
  windows: z.array(checkWindowSchema),
  timeZone: z.string(),
});
const windowDetailWrapperSchema = z.object({ window: windowDetailSchema });

export async function listWindows(
  participantId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ windows: CheckWindow[]; timeZone: string }> {
  const query = new URLSearchParams();
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return windowListSchema.parse(
    await request(`/v1/participants/${participantId}/windows${suffix}`),
  );
}

export async function getWindow(id: string): Promise<WindowDetail> {
  return windowDetailWrapperSchema.parse(await request(`/v1/windows/${id}`)).window;
}

export async function putEntry(windowId: string, input: PutEntryRequest): Promise<WindowDetail> {
  return z
    .object({ entry: z.unknown(), window: windowDetailSchema })
    .parse(await request(`/v1/windows/${windowId}/entry`, { method: 'PUT', body: input })).window;
}

export async function editEntry(entryId: string, input: EditEntryRequest): Promise<WindowDetail> {
  return z
    .object({ entry: z.unknown(), window: windowDetailSchema })
    .parse(await request(`/v1/check-entries/${entryId}`, { method: 'PATCH', body: input })).window;
}

export async function listEntryRevisions(entryId: string): Promise<EntryRevision[]> {
  return z
    .object({ revisions: z.array(entryRevisionSchema) })
    .parse(await request(`/v1/check-entries/${entryId}/revisions`)).revisions;
}

export async function putMissReason(
  windowId: string,
  input: PutMissReasonRequest,
): Promise<WindowDetail> {
  return z
    .object({ missReason: missReasonSchema, window: windowDetailSchema })
    .parse(await request(`/v1/windows/${windowId}/miss-reason`, { method: 'PUT', body: input }))
    .window;
}

export async function listReasonCodes(): Promise<MissedReasonCode[]> {
  return z
    .object({ reasonCodes: z.array(missedReasonCodeSchema) })
    .parse(await request('/v1/missed-reason-codes')).reasonCodes;
}

/** The Today screen's feed, scoped to the caller's own participants. */
export async function listDueWindows(
  withinMinutes?: number,
): Promise<{ windows: CheckWindow[]; timeZone: string }> {
  const query = withinMinutes === undefined ? '' : `?within=${withinMinutes}`;
  return windowListSchema.parse(await request(`/v1/me/windows/due${query}`));
}
