import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Key material (doc 03 §12, doc 07 §2).
 *
 * The master key comes from the environment, is never in the repository, never
 * in the image, and never in a log. Per-purpose keys are derived from it with
 * HKDF rather than reusing one key everywhere, so the field-encryption key and
 * the blind-index key are cryptographically separate as the docs require.
 *
 * Keys are versioned. Ciphertext records its version, so rotation is a
 * background re-encryption job rather than an outage.
 */

const MASTER_KEY_BYTES = 32;

export type KeyVersion = number;

export class KeyRing {
  /** version -> master key bytes */
  private readonly masters = new Map<KeyVersion, Buffer>();
  readonly currentVersion: KeyVersion;

  constructor(masters: Map<KeyVersion, Buffer>, currentVersion: KeyVersion) {
    if (masters.size === 0) throw new Error('A key ring needs at least one key');
    if (!masters.has(currentVersion)) {
      throw new Error(`No master key for current version ${currentVersion}`);
    }
    for (const [version, key] of masters) {
      if (key.length !== MASTER_KEY_BYTES) {
        throw new Error(`Master key v${version} must be ${MASTER_KEY_BYTES} bytes`);
      }
      this.masters.set(version, key);
    }
    this.currentVersion = currentVersion;
  }

  /**
   * Parses `MASTER_KEY` / `MASTER_KEYS`.
   *
   * Single key:   `<base64>`                    (treated as version 1)
   * Versioned:    `1:<base64>,2:<base64>`       (highest version is current)
   */
  static fromEnv(value: string): KeyRing {
    const entries = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (entries.length === 0) throw new Error('MASTER_KEY is empty');

    const masters = new Map<KeyVersion, Buffer>();

    for (const entry of entries) {
      const separator = entry.indexOf(':');
      const hasVersion = separator > 0 && /^\d+$/.test(entry.slice(0, separator));
      const version = hasVersion ? Number(entry.slice(0, separator)) : 1;
      const encoded = hasVersion ? entry.slice(separator + 1) : entry;

      const key = Buffer.from(encoded, 'base64');
      if (key.length !== MASTER_KEY_BYTES) {
        throw new Error(
          `Master key v${version} decodes to ${key.length} bytes, expected ${MASTER_KEY_BYTES}. ` +
            'Generate one with: openssl rand -base64 32',
        );
      }
      if (masters.has(version)) throw new Error(`Duplicate master key version ${version}`);
      masters.set(version, key);
    }

    const currentVersion = Math.max(...masters.keys());
    return new KeyRing(masters, currentVersion);
  }

  private master(version: KeyVersion): Buffer {
    const key = this.masters.get(version);
    if (!key) {
      throw new Error(
        `No master key for version ${version}. It is still needed to read existing ciphertext.`,
      );
    }
    return key;
  }

  /**
   * Per-purpose, per-version derived key. `purpose` separates the field
   * encryption key from the blind index key; `context` separates one table's
   * data key from another's, which is the envelope layer.
   */
  derive(
    purpose: 'field' | 'bidx' | 'token',
    context: string,
    version = this.currentVersion,
  ): Buffer {
    const info = Buffer.from(`vigilo:${purpose}:${context}:v${version}`, 'utf8');
    const salt = Buffer.from('vigilo-hkdf-salt', 'utf8');
    return Buffer.from(hkdfSync('sha256', this.master(version), salt, info, 32));
  }

  /** Every version we still hold, oldest first. Used by the rotation job. */
  versions(): KeyVersion[] {
    return [...this.masters.keys()].sort((a, b) => a - b);
  }
}

/**
 * HMAC over a normalised value, for exact-match lookup without decryption
 * (doc 03 §12). Exact match only: no prefix, no range. It leaks equality,
 * which is the accepted trade-off.
 */
export function blindIndex(keyRing: KeyRing, column: string, plaintext: string): Buffer {
  const normalised = plaintext.trim().toLowerCase();
  const key = keyRing.derive('bidx', column);
  return createHmac('sha256', key).update(normalised, 'utf8').digest();
}
