import {
  alertSchema,
  apiErrorSchema,
  assignableStaffSchema,
  assignmentSchema,
  supportTeamChangeSchema,
  attachmentSchema,
  checkFormExportSchema,
  checkScheduleSchema,
  checkTemplateSchema,
  checkWindowSchema,
  clockSkewMs,
  coverageExceptionSchema,
  coveragePatternSchema,
  diaryCategorySchema,
  diaryEntrySchema,
  diaryRevisionSchema,
  emergencyContactSchema,
  emergencyPlanSchema,
  entryNoteSchema,
  entryRevisionSchema,
  healthResponseSchema,
  importCheckFormsResponseSchema,
  missReasonSchema,
  missedReasonCodeSchema,
  publishPreviewSchema,
  recalculationPreviewSchema,
  schedulePreviewSchema,
  templateVersionSchema,
  timelineItemSchema,
  windowDetailSchema,
  participantDetailSchema,
  participantSummarySchema,
  carePlanSchema,
  carePlanVersionSchema,
  incidentSchema,
  medicationAdministrationSchema,
  medicationDoseSchema,
  medicationSchema,
  myDaySchema,
  myRecordsSchema,
  loginResponseSchema,
  meResponseSchema,
  passkeySummarySchema,
  quickSignInCredentialSchema,
  quickSignInSummarySchema,
  type PasskeyAuthentication,
  type PasskeyRegistration,
  type PasskeySummary,
  type QuickSignInCredential,
  type QuickSignInMethod,
  type QuickSignInSummary,
  readyResponseSchema,
  totpEnrolResponseSchema,
  userSummarySchema,
  type Attachment,
  type CheckFormExport,
  type CheckSchedule,
  type CheckTemplate,
  type CheckWindow,
  type CoverageException,
  type CoveragePattern,
  type CreateAlertRequest,
  type AssignableStaff,
  type CreateAssignmentRequest,
  type SupportTeamChange,
  type CreateContactRequest,
  type CreateAttachmentRequest,
  type CreateCoverageExceptionRequest,
  type CreateDiaryCategoryRequest,
  type CreateDiaryEntryRequest,
  type CreateParticipantRequest,
  type CreateScheduleRequest,
  type CreateTemplateRequest,
  type ParticipantFormChoice,
  type DiaryCategory,
  type DiaryEntry,
  type DiaryQuery,
  type DiaryRevision,
  type EditEntryRequest,
  type EmergencyContact,
  type EmergencyPlan,
  type AddEntryNoteRequest,
  type EntryNote,
  type EntryRevision,
  type ErrorCode,
  type HealthResponse,
  type ImportCheckFormsRequest,
  type ImportedForm,
  type CarePlan,
  type CarePlanVersion,
  type CloseIncidentRequest,
  type CompleteIncidentActionRequest,
  type CreateCarePlanRequest,
  type CreateIncidentActionRequest,
  type CreateIncidentRequest,
  type CreateMedicationRequest,
  type Incident,
  type IncidentQuery,
  type MyDay,
  type MyRecords,
  type MarkCarePlanReadRequest,
  type PublishCarePlanVersionRequest,
  type ReopenIncidentRequest,
  type UpdateCarePlanRequest,
  type UpdateCarePlanVersionRequest,
  type UpdateIncidentRequest,
  type Medication,
  type MedicationAdministration,
  type MedicationDose,
  type MissedReasonCode,
  type PutMedicationSchedulesRequest,
  type RecordPrnRequest,
  type SignOffRequest,
  type UpdateAdministrationRequest,
  type UpdateMedicationRequest,
  type PreviewScheduleRequest,
  type PublishPreview,
  type PutCoveragePatternRequest,
  checkEntrySchema,
  type CheckEntry,
  type PutEntryRequest,
  type RecordUnscheduledCheckRequest,
  type PutMissReasonRequest,
  type PutSegmentsRequest,
  type RecalculateCoverageRequest,
  type RecalculationPreview,
  type SchedulePreview,
  type TemplateSchema,
  type TemplateVersion,
  type TimelineItem,
  type UpdateDiaryCategoryRequest,
  type UpdateDiaryEntryRequest,
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
  deviceSchema,
  syncBootstrapResponseSchema,
  syncChangesResponseSchema,
  syncPushResponseSchema,
  type Device,
  type OutboxOperation,
  type RegisterDeviceRequest,
  type SyncBootstrapResponse,
  type SyncChangesResponse,
  type SyncPushResponse,
  complianceReportSchema,
  dailyReportSchema,
  exportJobSchema,
  trendSeriesSchema,
  type ComplianceGrouping,
  type ComplianceReport,
  type DailyReport,
  type ExportJob,
  type ExportQuery,
  type TrendBucket,
  type TrendSeries,
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

/**
 * This device's id, sent on every request.
 *
 * Not a credential: the server records it on audit rows and uses it to move
 * this device's own sync cursor, and every query that touches a device row
 * also matches on the user.
 */
let deviceId: string | null = null;

export function setDeviceId(id: string): void {
  deviceId = id;
}

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = csrfToken();
  }

  if (deviceId !== null) headers['X-Device-Id'] = deviceId;

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

/* --------------------------------------------------- passkeys and quick sign-in */

/**
 * The passkey ceremonies (#24).
 *
 * The options blob is passed through as it came, because it is the WebAuthn
 * spec's own shape and the platform adapter is what knows how to feed it to a
 * browser. Parsing it into something of our own here would be inventing a
 * second contract for no gain.
 */
const optionsSchema = z.object({ options: z.record(z.unknown()) });

export async function passkeyRegistrationOptions(): Promise<Record<string, unknown>> {
  return optionsSchema.parse(await request('/v1/auth/passkeys/options', { method: 'POST' }))
    .options;
}

export async function registerPasskey(
  name: string,
  credential: PasskeyRegistration,
): Promise<PasskeySummary> {
  return z
    .object({ passkey: passkeySummarySchema })
    .parse(await request('/v1/auth/passkeys', { method: 'POST', body: { name, credential } }))
    .passkey;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  return z
    .object({ passkeys: z.array(passkeySummarySchema) })
    .parse(await request('/v1/auth/passkeys')).passkeys;
}

export async function renamePasskey(id: string, name: string): Promise<PasskeySummary> {
  return z
    .object({ passkey: passkeySummarySchema })
    .parse(await request(`/v1/auth/passkeys/${id}`, { method: 'PATCH', body: { name } })).passkey;
}

export async function removePasskey(id: string): Promise<void> {
  await request(`/v1/auth/passkeys/${id}`, { method: 'DELETE' });
}

export async function passkeySignInOptions(): Promise<Record<string, unknown>> {
  return optionsSchema.parse(
    await request('/v1/auth/passkey/options', { method: 'POST', body: {} }),
  ).options;
}

export async function passkeyLogin(credential: PasskeyAuthentication): Promise<LoginResponse> {
  return loginResponseSchema.parse(
    await request('/v1/auth/passkey/login', { method: 'POST', body: { credential } }),
  );
}

export async function enrolQuickSignIn(
  method: QuickSignInMethod,
  label: string,
): Promise<QuickSignInCredential> {
  return z
    .object({ credential: quickSignInCredentialSchema })
    .parse(
      await request('/v1/auth/quick-sign-in/enrol', { method: 'POST', body: { method, label } }),
    ).credential;
}

export async function listQuickSignIns(): Promise<QuickSignInSummary[]> {
  return z
    .object({ devices: z.array(quickSignInSummarySchema) })
    .parse(await request('/v1/auth/quick-sign-in')).devices;
}

export async function removeQuickSignIn(id: string): Promise<void> {
  await request(`/v1/auth/quick-sign-in/${id}`, { method: 'DELETE' });
}

export async function quickSignIn(credentialId: string, secret: string): Promise<LoginResponse> {
  return loginResponseSchema.parse(
    await request('/v1/auth/quick-sign-in', { method: 'POST', body: { credentialId, secret } }),
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

/** The support team (D87): who could be on it, and setting the whole list. */
export async function listSupportTeam(participantId: string): Promise<AssignableStaff[]> {
  return z
    .object({ staff: z.array(assignableStaffSchema) })
    .parse(await request(`/v1/participants/${participantId}/support-team`)).staff;
}

export async function setSupportTeam(
  participantId: string,
  userIds: string[],
): Promise<{ change: SupportTeamChange; staff: AssignableStaff[] }> {
  return z.object({ change: supportTeamChangeSchema, staff: z.array(assignableStaffSchema) }).parse(
    await request(`/v1/participants/${participantId}/support-team`, {
      method: 'PUT',
      body: { userIds },
    }),
  );
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

/**
 * Check forms as a file (D91).
 *
 * Ordinary JSON through `request`, not a download link, because the errors
 * matter: an admin who is not allowed to export needs to be told that, and a
 * link the browser follows would hand them a page of JSON instead. The file is
 * built from the parsed document on the way out.
 */
export async function exportCheckForms(ids: readonly string[] = []): Promise<CheckFormExport> {
  const query = ids.length === 0 ? '' : `?ids=${ids.join(',')}`;
  return checkFormExportSchema.parse(await request(`/v1/check-templates/export${query}`));
}

export async function importCheckForms(document: ImportCheckFormsRequest): Promise<ImportedForm[]> {
  return importCheckFormsResponseSchema.parse(
    await request('/v1/check-templates/import', { method: 'POST', body: document }),
  ).imported;
}

// Schedules and coverage (doc 04 §6).
const scheduleWrapperSchema = z.object({ schedule: checkScheduleSchema });
const regeneratedSchema = z.object({
  removed: z.number(),
  created: z.number(),
  preserved: z.number(),
});
const removedSchema = z.object({ removed: z.number(), keptWithEntry: z.number() });

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

/**
 * Ends a schedule. Everything still open on it is removed with it (D97), and
 * the response says how many, and how many were kept because somebody had
 * already recorded against them.
 */
export async function endSchedule(
  scheduleId: string,
): Promise<{ schedule: CheckSchedule; removed: z.infer<typeof removedSchema> }> {
  return z
    .object({ schedule: checkScheduleSchema, removed: removedSchema })
    .parse(await request(`/v1/schedules/${scheduleId}`, { method: 'DELETE' }));
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

/** Forms a worker can record on demand, and the write itself (D89). */
export async function listRecordableForms(
  participantId: string,
): Promise<{ id: string; name: string; description: string | null }[]> {
  return z
    .object({
      forms: z.array(
        z.object({ id: z.string(), name: z.string(), description: z.string().nullable() }),
      ),
    })
    .parse(await request(`/v1/participants/${participantId}/recordable-forms`)).forms;
}

/** The admin tick list: which forms apply to this participant (D94). */
const formChoicesSchema = z.object({
  forms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      assigned: z.boolean(),
      recordable: z.boolean(),
    }),
  ),
});

export async function listParticipantFormChoices(
  participantId: string,
): Promise<ParticipantFormChoice[]> {
  return formChoicesSchema.parse(await request(`/v1/participants/${participantId}/form-choices`))
    .forms;
}

export async function setParticipantForms(
  participantId: string,
  templateIds: string[],
): Promise<ParticipantFormChoice[]> {
  return formChoicesSchema.parse(
    await request(`/v1/participants/${participantId}/forms`, {
      method: 'PUT',
      body: { templateIds },
    }),
  ).forms;
}

export async function recordUnscheduledCheck(
  participantId: string,
  input: RecordUnscheduledCheckRequest,
): Promise<CheckEntry> {
  return z
    .object({ entry: checkEntrySchema })
    .parse(
      await request(`/v1/participants/${participantId}/checks`, { method: 'POST', body: input }),
    ).entry;
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

/**
 * Notes on a recorded check (D96).
 *
 * Server-only, like the edit history above it and for the same reason: they
 * are written against a record the server already holds, and there is nothing
 * useful a device could do with a queued one.
 */
export async function listEntryNotes(entryId: string): Promise<EntryNote[]> {
  return z
    .object({ notes: z.array(entryNoteSchema) })
    .parse(await request(`/v1/check-entries/${entryId}/notes`)).notes;
}

export async function addEntryNote(
  entryId: string,
  input: AddEntryNoteRequest,
): Promise<EntryNote> {
  return z
    .object({ note: entryNoteSchema })
    .parse(await request(`/v1/check-entries/${entryId}/notes`, { method: 'POST', body: input }))
    .note;
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

// Diary (doc 04 §8).
const diaryListSchema = z.object({
  entries: z.array(diaryEntrySchema),
  timeZone: z.string(),
});

export async function listDiary(
  participantId: string,
  query: Partial<DiaryQuery> = {},
): Promise<{ entries: DiaryEntry[]; timeZone: string }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return diaryListSchema.parse(await request(`/v1/participants/${participantId}/diary${suffix}`));
}

export async function createDiaryEntry(
  participantId: string,
  input: CreateDiaryEntryRequest,
): Promise<DiaryEntry> {
  return z
    .object({ entry: diaryEntrySchema })
    .parse(
      await request(`/v1/participants/${participantId}/diary`, { method: 'POST', body: input }),
    ).entry;
}

export async function updateDiaryEntry(
  entryId: string,
  input: UpdateDiaryEntryRequest,
): Promise<DiaryEntry> {
  return z
    .object({ entry: diaryEntrySchema })
    .parse(await request(`/v1/diary-entries/${entryId}`, { method: 'PATCH', body: input })).entry;
}

export async function deleteDiaryEntry(entryId: string): Promise<void> {
  await request(`/v1/diary-entries/${entryId}`, { method: 'DELETE' });
}

export async function listDiaryRevisions(entryId: string): Promise<DiaryRevision[]> {
  return z
    .object({ revisions: z.array(diaryRevisionSchema) })
    .parse(await request(`/v1/diary-entries/${entryId}/revisions`)).revisions;
}

export async function listDiaryCategories(includeInactive = false): Promise<DiaryCategory[]> {
  const suffix = includeInactive ? '?includeInactive=true' : '';
  return z
    .object({ categories: z.array(diaryCategorySchema) })
    .parse(await request(`/v1/diary-categories${suffix}`)).categories;
}

export async function createDiaryCategory(
  input: CreateDiaryCategoryRequest,
): Promise<DiaryCategory> {
  return z
    .object({ category: diaryCategorySchema })
    .parse(await request('/v1/diary-categories', { method: 'POST', body: input })).category;
}

export async function updateDiaryCategory(
  id: string,
  input: UpdateDiaryCategoryRequest,
): Promise<DiaryCategory> {
  return z
    .object({ category: diaryCategorySchema })
    .parse(await request(`/v1/diary-categories/${id}`, { method: 'PATCH', body: input })).category;
}

/** The merged timeline (doc 04 §3), which is the participant's main screen. */
export async function getTimeline(
  participantId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ items: TimelineItem[]; timeZone: string }> {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return z
    .object({ items: z.array(timelineItemSchema), timeZone: z.string() })
    .parse(await request(`/v1/participants/${participantId}/timeline${suffix}`));
}

// Attachments (doc 04 §9). Metadata first, then the bytes.
export async function createAttachment(
  participantId: string,
  input: CreateAttachmentRequest,
): Promise<Attachment> {
  return z.object({ attachment: attachmentSchema }).parse(
    await request(`/v1/participants/${participantId}/attachments`, {
      method: 'POST',
      body: input,
    }),
  ).attachment;
}

/**
 * The bytes, as a raw body rather than multipart.
 *
 * This is the one call that does not go through `request`: it sends a Blob
 * rather than JSON, and the envelope a multipart form would add carries
 * nothing the URL does not already say.
 */
export async function uploadAttachmentContent(id: string, file: Blob): Promise<Attachment> {
  const response = await fetch(`/api/v1/attachments/${id}/content`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-CSRF-Token': csrfToken(),
    },
    body: file,
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(code, message, details);
    }
    throw new ApiRequestError('server_error', 'That file could not be uploaded.');
  }

  return z.object({ attachment: attachmentSchema }).parse(body).attachment;
}

export async function deleteAttachment(id: string): Promise<void> {
  await request(`/v1/attachments/${id}`, { method: 'DELETE' });
}

/** Both go through the API with a scope check, never served statically. */
export function attachmentUrl(id: string): string {
  return `/api/v1/attachments/${id}`;
}

export function thumbnailUrl(id: string): string {
  return `/api/v1/attachments/${id}/thumb`;
}

/* ------------------------------------------------------------------ sync */

/**
 * The three sync endpoints (doc 04 §13) and the device registration they hang
 * off. Responses are parsed against the shared schemas like everything else,
 * so a server sending a shape this build does not understand fails here rather
 * than halfway through a local transaction.
 */
export async function registerDevice(request_: RegisterDeviceRequest): Promise<Device> {
  return z
    .object({ device: deviceSchema })
    .parse(await request('/v1/devices', { method: 'POST', body: request_ })).device;
}

export async function getDevice(id: string): Promise<Device> {
  return z.object({ device: deviceSchema }).parse(await request(`/v1/devices/${id}`)).device;
}

export async function syncBootstrap(): Promise<SyncBootstrapResponse> {
  return syncBootstrapResponseSchema.parse(await request('/v1/sync/bootstrap'));
}

export async function syncChanges(since: number, limit = 500): Promise<SyncChangesResponse> {
  return syncChangesResponseSchema.parse(
    await request(`/v1/sync/changes?since=${since}&limit=${limit}`),
  );
}

export async function syncPush(operations: OutboxOperation[]): Promise<SyncPushResponse> {
  return syncPushResponseSchema.parse(
    await request('/v1/sync/push', {
      method: 'POST',
      body: { operations, sentAt: new Date().toISOString() },
    }),
  );
}

/**
 * Attachment bytes for the upload queue.
 *
 * Separate from `uploadAttachment` because the queue holds raw bytes it read
 * back out of the local database rather than a File the user just picked.
 */
export async function uploadAttachmentBytes(
  id: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<Attachment> {
  const response = await fetch(`/api/v1/attachments/${id}/content`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': mimeType,
      'X-CSRF-Token': csrfToken(),
      ...(deviceId === null ? {} : { 'X-Device-Id': deviceId }),
    },
    body: new Blob([bytes as BlobPart]),
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(code, message, details);
    }
    throw new ApiRequestError('server_error', 'That file could not be uploaded.');
  }

  return z.object({ attachment: attachmentSchema }).parse(body).attachment;
}

/* --------------------------------------------------------------- reports */

/**
 * Reports (doc 04 §11). The PDF and the CSV are not here: they are downloads,
 * and a download is a link the browser follows rather than a fetch we buffer
 * into memory and hand back.
 */
export async function getDailyReport(
  participantId: string,
  from: string,
  to: string,
): Promise<DailyReport> {
  return z
    .object({ report: dailyReportSchema })
    .parse(await request(`/v1/reports/daily?participantId=${participantId}&from=${from}&to=${to}`))
    .report;
}

export function dailyReportPdfUrl(participantId: string, from: string, to: string): string {
  return `/api/v1/reports/daily.pdf?participantId=${participantId}&from=${from}&to=${to}`;
}

export async function getComplianceReport(query: {
  from: string;
  to: string;
  groupBy: ComplianceGrouping;
  participantId?: string;
  userId?: string;
}): Promise<ComplianceReport> {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    ...(query.participantId ? { participantId: query.participantId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
  });
  return z
    .object({ report: complianceReportSchema })
    .parse(await request(`/v1/reports/compliance?${params.toString()}`)).report;
}

export async function getTrend(query: {
  participantId: string;
  fieldKey: string;
  from: string;
  to: string;
  bucket: TrendBucket;
}): Promise<TrendSeries> {
  const params = new URLSearchParams(query);
  return z
    .object({ series: trendSeriesSchema })
    .parse(await request(`/v1/reports/trends?${params.toString()}`)).series;
}

const trendFieldSchema = z.object({
  fieldKey: z.string(),
  label: z.string(),
  unit: z.string().nullable(),
  readings: z.number(),
});

export type TrendField = z.infer<typeof trendFieldSchema>;

export async function listTrendFields(participantId: string): Promise<TrendField[]> {
  return z
    .object({ fields: z.array(trendFieldSchema) })
    .parse(await request(`/v1/reports/trend-fields?participantId=${participantId}`)).fields;
}

/* --------------------------------------------------------------- exports */

/**
 * Asks for an export.
 *
 * Two possible answers, which is why this does not go through `request`. A
 * small export comes back as the file itself; a large one comes back as a job
 * to poll. The browser is handed a blob in the first case and a job id in the
 * second.
 */
export async function requestExport(
  query: ExportQuery,
): Promise<{ kind: 'file'; blob: Blob; filename: string } | { kind: 'job'; job: ExportJob }> {
  const response = await fetch('/api/v1/exports', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    body: JSON.stringify(query),
  });

  if (response.status === 202) {
    const body: unknown = await response.json();
    return { kind: 'job', job: z.object({ job: exportJobSchema }).parse(body).job };
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(code, message, details);
    }
    throw new ApiRequestError('server_error', 'That export could not be made.');
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'vigilo-export.csv';
  return { kind: 'file', blob: await response.blob(), filename };
}

export async function listExportJobs(): Promise<ExportJob[]> {
  return z.object({ jobs: z.array(exportJobSchema) }).parse(await request('/v1/exports')).jobs;
}

export async function getExportJob(id: string): Promise<ExportJob> {
  return z.object({ job: exportJobSchema }).parse(await request(`/v1/exports/${id}`)).job;
}

export function exportDownloadUrl(id: string): string {
  return `/api/v1/exports/${id}/download`;
}

/* --------------------------------------------------------- medications */

// Doc 04 §10.
const medicationListSchema = z.object({ medications: z.array(medicationSchema) });
const doseListSchema = z.object({ doses: z.array(medicationDoseSchema), timeZone: z.string() });
const administrationListSchema = z.object({
  administrations: z.array(medicationAdministrationSchema),
  timeZone: z.string(),
});

export async function listMedications(
  participantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<Medication[]> {
  const query = options.includeInactive ? '?includeInactive=true' : '';
  return medicationListSchema.parse(
    await request(`/v1/participants/${participantId}/medications${query}`),
  ).medications;
}

export async function createMedication(
  participantId: string,
  input: CreateMedicationRequest,
): Promise<Medication> {
  return z.object({ medication: medicationSchema }).parse(
    await request(`/v1/participants/${participantId}/medications`, {
      method: 'POST',
      body: input,
    }),
  ).medication;
}

export async function updateMedication(
  id: string,
  input: UpdateMedicationRequest,
): Promise<Medication> {
  return z
    .object({ medication: medicationSchema })
    .parse(await request(`/v1/medications/${id}`, { method: 'PATCH', body: input })).medication;
}

export async function putMedicationSchedules(
  id: string,
  input: PutMedicationSchedulesRequest,
): Promise<Medication> {
  return z
    .object({ medication: medicationSchema })
    .parse(await request(`/v1/medications/${id}/schedules`, { method: 'PUT', body: input }))
    .medication;
}

export async function listDoses(
  participantId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ doses: MedicationDose[]; timeZone: string }> {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const query = params.toString();

  return doseListSchema.parse(
    await request(
      `/v1/participants/${participantId}/medication-doses${query === '' ? '' : `?${query}`}`,
    ),
  );
}

export async function listDueDoses(
  withinMinutes?: number,
): Promise<{ doses: MedicationDose[]; timeZone: string }> {
  const query = withinMinutes === undefined ? '' : `?within=${withinMinutes}`;
  return doseListSchema.parse(await request(`/v1/me/medication-doses/due${query}`));
}

export async function listAdministrations(
  participantId: string,
  range: { from?: string; to?: string } = {},
): Promise<MedicationAdministration[]> {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const query = params.toString();

  return administrationListSchema.parse(
    await request(
      `/v1/participants/${participantId}/medication-administrations${query === '' ? '' : `?${query}`}`,
    ),
  ).administrations;
}

export async function signOffDose(
  doseId: string,
  input: SignOffRequest,
): Promise<MedicationAdministration> {
  return z.object({ administration: medicationAdministrationSchema }).parse(
    await request(`/v1/medication-doses/${doseId}/administration`, {
      method: 'PUT',
      body: input,
    }),
  ).administration;
}

export async function recordPrn(
  participantId: string,
  input: RecordPrnRequest,
): Promise<MedicationAdministration> {
  return z.object({ administration: medicationAdministrationSchema }).parse(
    await request(`/v1/participants/${participantId}/medication-administrations`, {
      method: 'POST',
      body: input,
    }),
  ).administration;
}

export async function updateAdministration(
  id: string,
  input: UpdateAdministrationRequest,
): Promise<MedicationAdministration> {
  return z
    .object({ administration: medicationAdministrationSchema })
    .parse(await request(`/v1/medication-administrations/${id}`, { method: 'PATCH', body: input }))
    .administration;
}

const colleagueSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
});

export type Colleague = z.infer<typeof colleagueSchema>;

/** Active staff a sign-off can name as a witness (doc 01 §7.2). */
export async function listColleagues(): Promise<Colleague[]> {
  return z
    .object({ colleagues: z.array(colleagueSchema) })
    .parse(await request('/v1/me/colleagues')).colleagues;
}

/* ------------------------------------------------------- care plans */

// Doc 04 §10.
const carePlanListSchema = z.object({ carePlans: z.array(carePlanSchema) });

export async function listCarePlans(participantId: string): Promise<CarePlan[]> {
  return carePlanListSchema.parse(await request(`/v1/participants/${participantId}/care-plans`))
    .carePlans;
}

export async function getCarePlan(id: string): Promise<CarePlan> {
  return z.object({ carePlan: carePlanSchema }).parse(await request(`/v1/care-plans/${id}`))
    .carePlan;
}

export async function createCarePlan(
  participantId: string,
  input: CreateCarePlanRequest,
): Promise<CarePlan> {
  return z.object({ carePlan: carePlanSchema }).parse(
    await request(`/v1/participants/${participantId}/care-plans`, {
      method: 'POST',
      body: input,
    }),
  ).carePlan;
}

export async function updateCarePlan(id: string, input: UpdateCarePlanRequest): Promise<CarePlan> {
  return z
    .object({ carePlan: carePlanSchema })
    .parse(await request(`/v1/care-plans/${id}`, { method: 'PATCH', body: input })).carePlan;
}

export async function listCarePlanVersions(id: string): Promise<CarePlanVersion[]> {
  return z
    .object({ versions: z.array(carePlanVersionSchema) })
    .parse(await request(`/v1/care-plans/${id}/versions`)).versions;
}

/** The draft to edit, made from what is published if there is not one yet. */
export async function openCarePlanDraft(id: string): Promise<CarePlanVersion | null> {
  return z
    .object({ draft: carePlanVersionSchema.nullable() })
    .parse(await request(`/v1/care-plans/${id}/draft`, { method: 'PUT' })).draft;
}

export async function updateCarePlanDraft(
  versionId: string,
  input: UpdateCarePlanVersionRequest,
): Promise<CarePlanVersion[]> {
  return z
    .object({ versions: z.array(carePlanVersionSchema) })
    .parse(await request(`/v1/care-plan-versions/${versionId}`, { method: 'PATCH', body: input }))
    .versions;
}

export async function publishCarePlanVersion(
  versionId: string,
  input: PublishCarePlanVersionRequest,
): Promise<{ carePlan: CarePlan; notified: number }> {
  return z.object({ carePlan: carePlanSchema, notified: z.number() }).parse(
    await request(`/v1/care-plan-versions/${versionId}/publish`, {
      method: 'POST',
      body: input,
    }),
  );
}

export async function discardCarePlanDraft(versionId: string): Promise<void> {
  await request(`/v1/care-plan-versions/${versionId}`, { method: 'DELETE' });
}

export async function markCarePlanRead(
  id: string,
  input: MarkCarePlanReadRequest,
): Promise<CarePlan> {
  return z
    .object({ carePlan: carePlanSchema })
    .parse(await request(`/v1/care-plans/${id}/read`, { method: 'POST', body: input })).carePlan;
}

export async function listCarePlanReceipts(
  id: string,
): Promise<{ userId: string; displayName: string; readAt: string }[]> {
  return z
    .object({
      receipts: z.array(
        z.object({ userId: z.string(), displayName: z.string(), readAt: z.string() }),
      ),
    })
    .parse(await request(`/v1/care-plans/${id}/read-receipts`)).receipts;
}

/* -------------------------------------------------------- incidents */

const incidentListSchema = z.object({
  incidents: z.array(incidentSchema),
  timeZone: z.string(),
});

export async function listIncidents(
  participantId: string,
  query: Partial<IncidentQuery> = {},
): Promise<{ incidents: Incident[]; timeZone: string }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
  return incidentListSchema.parse(
    await request(`/v1/participants/${participantId}/incidents${suffix}`),
  );
}

export async function listRecentIncidents(limit?: number): Promise<Incident[]> {
  const suffix = limit === undefined ? '' : `?limit=${limit}`;
  return z
    .object({ incidents: z.array(incidentSchema) })
    .parse(await request(`/v1/me/incidents/recent${suffix}`)).incidents;
}

export async function getIncident(id: string): Promise<Incident> {
  return z.object({ incident: incidentSchema }).parse(await request(`/v1/incidents/${id}`))
    .incident;
}

export async function createIncident(
  participantId: string,
  input: CreateIncidentRequest,
): Promise<Incident> {
  return z.object({ incident: incidentSchema }).parse(
    await request(`/v1/participants/${participantId}/incidents`, {
      method: 'POST',
      body: input,
    }),
  ).incident;
}

export async function updateIncident(id: string, input: UpdateIncidentRequest): Promise<Incident> {
  return z
    .object({ incident: incidentSchema })
    .parse(await request(`/v1/incidents/${id}`, { method: 'PATCH', body: input })).incident;
}

export async function closeIncident(
  id: string,
  input: CloseIncidentRequest,
): Promise<{ incident: Incident; actionsOutstanding: number }> {
  return z
    .object({ incident: incidentSchema, actionsOutstanding: z.number() })
    .parse(await request(`/v1/incidents/${id}/close`, { method: 'POST', body: input }));
}

export async function reopenIncident(id: string, input: ReopenIncidentRequest): Promise<Incident> {
  return z
    .object({ incident: incidentSchema })
    .parse(await request(`/v1/incidents/${id}/reopen`, { method: 'POST', body: input })).incident;
}

export async function addIncidentAction(
  id: string,
  input: CreateIncidentActionRequest,
): Promise<Incident> {
  return z
    .object({ incident: incidentSchema })
    .parse(await request(`/v1/incidents/${id}/actions`, { method: 'POST', body: input })).incident;
}

export async function completeIncidentAction(
  actionId: string,
  input: CompleteIncidentActionRequest,
): Promise<Incident> {
  return z
    .object({ incident: incidentSchema })
    .parse(
      await request(`/v1/incident-actions/${actionId}/complete`, { method: 'POST', body: input }),
    ).incident;
}

export function incidentPdfUrl(id: string): string {
  return `/api/v1/incidents/${id}/pdf`;
}

/* ------------------------------------------------------ participant self-access */

/**
 * The three self-access calls (doc 06 §6).
 *
 * No participant id in any of them. The server reads it off the session, so
 * there is nothing here for a screen to pass wrongly and nothing a person
 * could edit in the address bar to reach somebody else's record.
 */
export async function getMyDay(date?: string): Promise<{ day: MyDay; today: string }> {
  const query = date === undefined ? '' : `?date=${date}`;
  return z
    .object({
      day: myDaySchema,
      today: z.string(),
      participantName: z.string(),
      timeZone: z.string(),
    })
    .parse(await request(`/v1/me/day${query}`));
}

export async function getMyRecords(
  from: string,
  to: string,
): Promise<{ records: MyRecords; today: string }> {
  return z
    .object({ records: myRecordsSchema, today: z.string() })
    .parse(await request(`/v1/me/records?from=${from}&to=${to}`));
}

export function myRecordsPdfUrl(from: string, to: string): string {
  return `/api/v1/me/reports/daily.pdf?from=${from}&to=${to}`;
}
