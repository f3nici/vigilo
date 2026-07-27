import { z } from 'zod';
import { roleSchema, userStatusSchema } from './roles.js';

/**
 * Auth contracts (doc 04 §2). Validated by the client before sending and by
 * the server again on receipt.
 */

export const platforms = ['android', 'ios', 'web'] as const;
export const platformSchema = z.enum(platforms);
export type Platform = z.infer<typeof platformSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email('Enter a valid email address.');

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  /** Installed app only. A browser tab gets the office session cookie. */
  deviceId: z.string().uuid().optional(),
  platform: platformSchema.optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const totpChallengeRequestSchema = z.object({
  /** Opaque, short-lived, issued by /auth/login when TOTP is required. */
  challengeId: z.string().min(1).max(200),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
});

export const recoveryCodeRequestSchema = z.object({
  challengeId: z.string().min(1).max(200),
  code: z.string().trim().min(1).max(64),
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});

/** What the client knows about who it is signed in as. */
export const principalSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  participantId: z.string().uuid().nullable(),
  mustChangePassword: z.boolean(),
  totpEnabled: z.boolean(),
  /** Required to enrol before the account can be used at all. */
  totpRequired: z.boolean(),
});

export type Principal = z.infer<typeof principalSchema>;

export const scopeSummarySchema = z.object({
  /** True for an admin, who is not limited to a list. */
  all: z.boolean(),
  participantIds: z.array(z.string().uuid()),
});

export const meResponseSchema = z.object({
  principal: principalSchema,
  scope: scopeSummarySchema,
  org: z.object({
    name: z.string(),
    timezone: z.string(),
  }),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Login either completes or asks for a second factor. Never both. */
export const loginResponseSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('authenticated'),
    principal: principalSchema,
    /** Installed app only. The browser gets an httpOnly cookie instead. */
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  z.object({
    result: z.literal('totp_required'),
    challengeId: z.string(),
  }),
]);

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const totpEnrolResponseSchema = z.object({
  /** otpauth:// URI for the QR code. */
  provisioningUri: z.string(),
  secret: z.string(),
  /** Shown once, never again. */
  recoveryCodes: z.array(z.string()),
});

export type TotpEnrolResponse = z.infer<typeof totpEnrolResponseSchema>;

export const createUserRequestSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(200),
    role: roleSchema,
    participantId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => (value.role === 'participant') === Boolean(value.participantId), {
    message: 'A participant account needs a participant, and no other role may have one.',
    path: ['participantId'],
  });

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const userSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  participantId: z.string().uuid().nullable(),
  mustChangePassword: z.boolean(),
  totpEnabled: z.boolean(),
  lockedUntil: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;

/** A one-time password is shown once in the UI and handed over directly. */
export const issuedCredentialSchema = z.object({
  user: userSummarySchema,
  oneTimePassword: z.string(),
});

export type IssuedCredential = z.infer<typeof issuedCredentialSchema>;
