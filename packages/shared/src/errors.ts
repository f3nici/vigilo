import { z } from 'zod';

/**
 * The complete error code list from doc 04 §1. The API never invents a code
 * outside this set, so the client can exhaustively handle them.
 */
export const errorCodes = [
  'unauthenticated',
  'totp_required',
  'password_change_required',
  'scope_denied',
  'not_found',
  'validation_failed',
  'conflict',
  'template_version_mismatch',
  'rate_limited',
  'update_required',
  'server_error',
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    /** Safe to show a user. Never leaks whether a participant exists. */
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** HTTP status for each code, so routes never pick one by hand. */
export const errorStatus: Record<ErrorCode, number> = {
  unauthenticated: 401,
  totp_required: 401,
  password_change_required: 403,
  scope_denied: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  template_version_mismatch: 409,
  rate_limited: 429,
  update_required: 426,
  server_error: 500,
};

export function apiError(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return { error: { code, message, details } };
}
