import { z } from 'zod';
import { platformSchema } from './auth.js';

/**
 * Passkeys and quick sign-in (doc 01 §10, #24).
 *
 * Three ways in beside the password, and they are two different mechanisms
 * with two different jobs:
 *
 * - **A passkey** is a credential the server knows about, held by the
 *   authenticator rather than by Vigilo. It travels with the person: a passkey
 *   in an iCloud or Google keychain signs them in on their next phone without
 *   anybody reissuing anything. It replaces the password and the second factor
 *   at once, because the ceremony only completes after the device has verified
 *   the person holding it.
 * - **Quick sign-in** is a credential this one device holds, released by the
 *   phone's fingerprint or by a six-digit PIN. It is not a factor by itself
 *   (doc 01 §10): it is a way of getting at something already granted, on a
 *   device that has already signed in properly once. It never leaves the
 *   device and it cannot be moved to another one.
 *
 * Both are set up by the person themselves. Neither replaces the password: an
 * account with no password is an account an admin cannot hand back.
 */

/** Base64url, which is how every WebAuthn buffer crosses the wire. */
const base64UrlSchema = z
  .string()
  .min(1)
  .max(4000)
  .regex(/^[A-Za-z0-9_-]+$/, 'That is not a value Vigilo can read.');

export const passkeyTransports = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
  'cable',
] as const;

export const passkeyTransportSchema = z.enum(passkeyTransports);
export type PasskeyTransport = z.infer<typeof passkeyTransportSchema>;

/**
 * What the browser hands back from `navigator.credentials.create`, flattened.
 *
 * Deliberately not `z.unknown()` passed to the verifier: an unvalidated blob
 * from an unauthenticated caller going straight into a CBOR parser is a larger
 * surface than this route needs.
 */
export const passkeyRegistrationSchema = z
  .object({
    id: base64UrlSchema,
    rawId: base64UrlSchema,
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: base64UrlSchema,
      attestationObject: base64UrlSchema,
      transports: z.array(passkeyTransportSchema).max(8).optional(),
    }),
    clientExtensionResults: z.record(z.unknown()).default({}),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullish(),
  })
  .strict();

export type PasskeyRegistration = z.infer<typeof passkeyRegistrationSchema>;

export const registerPasskeyRequestSchema = z
  .object({
    /** What it is called in the list. "Ana's iPhone", not a serial number. */
    name: z.string().trim().min(1).max(80),
    credential: passkeyRegistrationSchema,
  })
  .strict();

export type RegisterPasskeyRequest = z.infer<typeof registerPasskeyRequestSchema>;

export const passkeyAuthenticationSchema = z
  .object({
    id: base64UrlSchema,
    rawId: base64UrlSchema,
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: base64UrlSchema,
      authenticatorData: base64UrlSchema,
      signature: base64UrlSchema,
      userHandle: base64UrlSchema.nullish(),
    }),
    clientExtensionResults: z.record(z.unknown()).default({}),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullish(),
  })
  .strict();

export type PasskeyAuthentication = z.infer<typeof passkeyAuthenticationSchema>;

export const passkeyLoginRequestSchema = z
  .object({
    credential: passkeyAuthenticationSchema,
    /** Installed app only, exactly as on a password sign-in. */
    deviceId: z.string().uuid().optional(),
    platform: platformSchema.optional(),
  })
  .strict();

export type PasskeyLoginRequest = z.infer<typeof passkeyLoginRequestSchema>;

/** One of the person's passkeys, as the security screen lists it. */
export const passkeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** True where the authenticator syncs it, which is the cross-device case. */
  syncedAcrossDevices: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export type PasskeySummary = z.infer<typeof passkeySummarySchema>;

export const renamePasskeyRequestSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

/* ------------------------------------------------------------ quick sign-in */

export const quickSignInMethods = ['biometric', 'pin'] as const;
export const quickSignInMethodSchema = z.enum(quickSignInMethods);
export type QuickSignInMethod = z.infer<typeof quickSignInMethodSchema>;

export const enrolQuickSignInRequestSchema = z
  .object({
    method: quickSignInMethodSchema,
    /** Whatever the person would recognise this device as. */
    label: z.string().trim().min(1).max(80),
  })
  .strict();

export type EnrolQuickSignInRequest = z.infer<typeof enrolQuickSignInRequestSchema>;

export const quickSignInCredentialSchema = z.object({
  credentialId: z.string(),
  /** Shown once, held only in this device's secure store from then on. */
  secret: z.string(),
  expiresAt: z.string(),
});

export type QuickSignInCredential = z.infer<typeof quickSignInCredentialSchema>;

export const quickSignInRequestSchema = z
  .object({
    credentialId: z.string().uuid(),
    secret: z.string().min(1).max(500),
    deviceId: z.string().uuid().optional(),
    platform: platformSchema.optional(),
  })
  .strict();

export type QuickSignInRequest = z.infer<typeof quickSignInRequestSchema>;

export const quickSignInSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  method: quickSignInMethodSchema,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
});

export type QuickSignInSummary = z.infer<typeof quickSignInSummarySchema>;

/**
 * How long a quick sign-in credential lasts without being used.
 *
 * A phone in a drawer stops being a way in. Sixty days matches the refresh
 * token, so nothing on a device outlives the session it came from.
 */
export const QUICK_SIGN_IN_DAYS = 60;

/**
 * A passkey is possession and verification in one ceremony, so it stands in
 * for the second factor (doc 01 §10).
 *
 * Registration and sign-in both demand `userVerification: 'required'`, which
 * means the authenticator only answers after a fingerprint, a face or a device
 * PIN. Accepting one without that would turn a stolen unlocked laptop into an
 * admin account, so the server checks the verified flag rather than trusting
 * that it asked for it.
 */
export const PASSKEY_USER_VERIFICATION = 'required';

/** Plain words for the list on the security screen. */
export function describePasskey(passkey: PasskeySummary): string {
  return passkey.syncedAcrossDevices
    ? 'Works on your other devices too'
    : 'Works on this device only';
}
