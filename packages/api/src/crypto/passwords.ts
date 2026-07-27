import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Password and token hashing (doc 07 §3).
 *
 * Argon2id, which is this library's default and is asserted by a test rather
 * than named here: the algorithm constant is an ambient const enum, which
 * `verbatimModuleSyntax` will not import. The parameters are the OWASP
 * baseline (19 MiB, 2 passes, 1 lane), a sensible balance for an API that also
 * serves sync.
 */
const argonOptions = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, argonOptions);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, argonOptions);
  } catch {
    // A malformed hash is a failed verification, never a 500.
    return false;
  }
}

/**
 * Words that cannot be confused when read down a phone line, which is how a
 * one-time password actually gets handed over here. No email, so an admin
 * reads this out or hands it over in person (doc 01 §10).
 */
const OTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/**
 * A one-time password long enough to satisfy the 12-character policy. Printed
 * once, never persisted in plaintext, never logged.
 */
export function generateOneTimePassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += OTP_ALPHABET[randomInt(OTP_ALPHABET.length)];
  }
  return out;
}

/** Recovery codes are shown once at enrolment and hashed at rest. */
export function generateRecoveryCode(): string {
  const raw = randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normaliseRecoveryCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Session and refresh tokens are high-entropy random values, so a fast hash is
 * correct here. Argon2 is for low-entropy secrets that humans choose.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare for hex digests of equal length. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
