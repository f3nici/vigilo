import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyRing } from './keys.js';

/**
 * Field encryption (doc 03 §12, doc 07 §2).
 *
 * AES-256-GCM, a random nonce per value, and the column name as additional
 * authenticated data so a ciphertext cannot be moved between columns. The
 * stored value carries its key version, which is what makes rotation a
 * background job rather than an outage.
 *
 * Wire format, all one buffer:
 *
 *   magic "V1" | keyVersion (uint16 BE) | nonce (12) | tag (16) | ciphertext
 */

const MAGIC = Buffer.from('V1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 2 + NONCE_BYTES + TAG_BYTES;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * `column` is the additional authenticated data. Pass the real column name,
 * for example `users.totp_secret_enc`, and pass the same one to decrypt.
 */
export function encryptField(keyRing: KeyRing, column: string, plaintext: string): Buffer {
  const version = keyRing.currentVersion;
  const key = keyRing.derive('field', column, version);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${column}:v${version}`, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(2);
  header.writeUInt16BE(version, 0);

  return Buffer.concat([MAGIC, header, nonce, tag, ciphertext]);
}

export function decryptField(keyRing: KeyRing, column: string, stored: Buffer): string {
  if (stored.length < HEADER_BYTES) {
    throw new DecryptionError(`Ciphertext for ${column} is too short to be valid`);
  }
  if (!stored.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new DecryptionError(`Ciphertext for ${column} has an unrecognised format`);
  }

  let offset = MAGIC.length;
  const version = stored.readUInt16BE(offset);
  offset += 2;
  const nonce = stored.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const tag = stored.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = stored.subarray(offset);

  const key = keyRing.derive('field', column, version);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(`${column}:v${version}`, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong column, or tampering. All the same to the caller, and
    // the reason never reaches a response.
    throw new DecryptionError(`Could not decrypt ${column}`);
  }
}

/** Which key version a stored value was written with, for the rotation job. */
export function ciphertextKeyVersion(stored: Buffer): number {
  if (stored.length < MAGIC.length + 2 || !stored.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new DecryptionError('Ciphertext has an unrecognised format');
  }
  return stored.readUInt16BE(MAGIC.length);
}

export function encryptOptional(
  keyRing: KeyRing,
  column: string,
  plaintext: string | null,
): Buffer | null {
  return plaintext === null ? null : encryptField(keyRing, column, plaintext);
}

export function decryptOptional(
  keyRing: KeyRing,
  column: string,
  stored: Buffer | null,
): string | null {
  return stored === null ? null : decryptField(keyRing, column, stored);
}
