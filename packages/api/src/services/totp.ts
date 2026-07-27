import { Secret, TOTP } from 'otpauth';

/**
 * TOTP (doc 01 §10). Mandatory for admin, team leader and nurse; optional for
 * workers. The secret is stored envelope-encrypted, never in the clear.
 */

const ISSUER = 'Vigilo';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One period either side, so a code is accepted across a clock skew of up to
 * 30 seconds. Wider than that starts to matter for replay.
 */
const WINDOW = 1;

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The otpauth:// URI the enrolment QR code encodes. */
export function totpProvisioningUri(secretBase32: string, email: string): string {
  return totpFor(secretBase32, email).toString();
}

export function verifyTotp(secretBase32: string, code: string): boolean {
  const normalised = code.trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalised)) return false;

  const delta = totpFor(secretBase32, 'verify').validate({ token: normalised, window: WINDOW });
  return delta !== null;
}
