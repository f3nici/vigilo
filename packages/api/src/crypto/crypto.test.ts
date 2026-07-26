import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyRing, blindIndex } from './keys.js';
import { ciphertextKeyVersion, DecryptionError, decryptField, encryptField } from './fields.js';
import { chainHash, GENESIS_HASH, verifyChain, type ChainRow } from './chain.js';
import {
  generateOneTimePassword,
  generateRecoveryCode,
  hashPassword,
  hashToken,
  normaliseRecoveryCode,
  tokenHashEquals,
  verifyPassword,
} from './passwords.js';
import { checkPassword } from '@vigilo/shared';

function key(): string {
  return randomBytes(32).toString('base64');
}

describe('KeyRing', () => {
  it('accepts a single unversioned key as version 1', () => {
    const ring = KeyRing.fromEnv(key());
    expect(ring.currentVersion).toBe(1);
  });

  it('takes the highest version as current', () => {
    const ring = KeyRing.fromEnv(`1:${key()},2:${key()}`);
    expect(ring.currentVersion).toBe(2);
    expect(ring.versions()).toEqual([1, 2]);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => KeyRing.fromEnv(randomBytes(16).toString('base64'))).toThrow(/expected 32/);
  });

  it('rejects duplicate versions', () => {
    expect(() => KeyRing.fromEnv(`1:${key()},1:${key()}`)).toThrow(/Duplicate/);
  });

  it('derives different keys for different purposes and columns', () => {
    const ring = KeyRing.fromEnv(key());
    const field = ring.derive('field', 'users.totp_secret_enc');
    const bidx = ring.derive('bidx', 'users.totp_secret_enc');
    const other = ring.derive('field', 'participants.ndis_number_enc');

    expect(field.equals(bidx)).toBe(false);
    expect(field.equals(other)).toBe(false);
  });
});

describe('blindIndex', () => {
  const ring = KeyRing.fromEnv(key());

  it('matches on exact normalised value', () => {
    expect(blindIndex(ring, 'c', '  ABC123 ').equals(blindIndex(ring, 'c', 'abc123'))).toBe(true);
  });

  it('does not match a different value', () => {
    expect(blindIndex(ring, 'c', 'abc123').equals(blindIndex(ring, 'c', 'abc124'))).toBe(false);
  });

  it('does not match the same value in a different column', () => {
    expect(blindIndex(ring, 'c1', 'abc').equals(blindIndex(ring, 'c2', 'abc'))).toBe(false);
  });
});

describe('field encryption', () => {
  const ring = KeyRing.fromEnv(key());
  const column = 'users.totp_secret_enc';

  it('round trips', () => {
    const stored = encryptField(ring, column, 'JBSWY3DPEHPK3PXP');
    expect(decryptField(ring, column, stored)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const a = encryptField(ring, column, 'same');
    const b = encryptField(ring, column, 'same');
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to decrypt under a different column, so ciphertext cannot be moved', () => {
    const stored = encryptField(ring, column, 'secret');
    expect(() => decryptField(ring, 'participants.notes_enc', stored)).toThrow(DecryptionError);
  });

  it('refuses to decrypt under a different key', () => {
    const stored = encryptField(ring, column, 'secret');
    expect(() => decryptField(KeyRing.fromEnv(key()), column, stored)).toThrow(DecryptionError);
  });

  it('detects tampering with the ciphertext', () => {
    const stored = encryptField(ring, column, 'secret');
    stored[stored.length - 1] ^= 0xff;
    expect(() => decryptField(ring, column, stored)).toThrow(DecryptionError);
  });

  it('records the key version and still reads an old version after rotation', () => {
    const k1 = key();
    const before = KeyRing.fromEnv(`1:${k1}`);
    const stored = encryptField(before, column, 'written under v1');
    expect(ciphertextKeyVersion(stored)).toBe(1);

    // Rotation adds v2 and keeps v1, so existing rows stay readable while the
    // re-encryption job works through them.
    const after = KeyRing.fromEnv(`1:${k1},2:${key()}`);
    expect(after.currentVersion).toBe(2);
    expect(decryptField(after, column, stored)).toBe('written under v1');

    const fresh = encryptField(after, column, 'written under v2');
    expect(ciphertextKeyVersion(fresh)).toBe(2);
    expect(decryptField(after, column, fresh)).toBe('written under v2');
  });

  it('cannot read v1 ciphertext once the v1 key is dropped', () => {
    const k1 = key();
    const stored = encryptField(KeyRing.fromEnv(`1:${k1}`), column, 'written under v1');
    const onlyV2 = KeyRing.fromEnv(`2:${key()}`);
    expect(() => decryptField(onlyV2, column, stored)).toThrow(/version 1/);
  });

  it('rejects a value that is not our format', () => {
    expect(() => decryptField(ring, column, Buffer.from('not ciphertext at all'))).toThrow(
      DecryptionError,
    );
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'wrong horse battery staple')).toBe(false);
  });

  it('uses argon2id', async () => {
    expect(await hashPassword('a long enough passphrase')).toMatch(/^\$argon2id\$/);
  });

  it('treats a malformed stored hash as a failure, not an error', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('one-time passwords', () => {
  it('satisfies the password policy it will be checked against', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(checkPassword({ password: generateOneTimePassword() })).toEqual([]);
    }
  });

  it('avoids characters that are ambiguous read aloud', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateOneTimePassword()).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('recovery codes', () => {
  it('normalises formatting and case', () => {
    const code = generateRecoveryCode();
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(normaliseRecoveryCode(code));
    expect(normaliseRecoveryCode(' ab-cd-ef ')).toBe('ABCDEF');
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 50 }, generateRecoveryCode));
    expect(codes.size).toBe(50);
  });
});

describe('token hashing', () => {
  it('compares equal hashes and rejects different ones', () => {
    expect(tokenHashEquals(hashToken('abc'), hashToken('abc'))).toBe(true);
    expect(tokenHashEquals(hashToken('abc'), hashToken('abd'))).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    expect(tokenHashEquals('short', hashToken('abc'))).toBe(false);
  });
});

describe('audit hash chain', () => {
  function row(id: number, prevHash: string, action: string): ChainRow {
    const fields = {
      at: new Date(`2026-07-26T10:0${id}:00.000Z`),
      actorUserId: null,
      actorIp: null,
      actorDeviceId: null,
      action,
      entityType: 'user',
      entityId: null,
      participantId: null,
      metadata: { seq: id },
    };
    return { id, prevHash, hash: chainHash(prevHash, fields), ...fields };
  }

  function chainOf(actions: string[]): ChainRow[] {
    const rows: ChainRow[] = [];
    let prev = GENESIS_HASH;
    actions.forEach((action, index) => {
      const next = row(index + 1, prev, action);
      rows.push(next);
      prev = next.hash;
    });
    return rows;
  }

  it('verifies an intact chain', () => {
    const result = verifyChain(chainOf(['auth.login', 'user.create', 'user.suspend']));
    expect(result).toEqual({ ok: true, rowsChecked: 3 });
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, rowsChecked: 0 });
  });

  it('detects an altered row', () => {
    const rows = chainOf(['auth.login', 'user.create', 'user.suspend']);
    rows[1] = { ...rows[1]!, action: 'user.delete' };

    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.brokenAtId).toBe(2);
    expect(result.ok === false && result.reason).toBe('hash_mismatch');
  });

  it('detects a removed row', () => {
    const rows = chainOf(['auth.login', 'user.create', 'user.suspend']);
    const withHole = [rows[0]!, rows[2]!];

    const result = verifyChain(withHole);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('prev_hash_mismatch');
  });

  it('is order independent in metadata, so re-reading JSON cannot break it', () => {
    const at = new Date('2026-07-26T10:00:00.000Z');
    const base = {
      at,
      actorUserId: null,
      actorIp: null,
      actorDeviceId: null,
      action: 'user.create',
      entityType: 'user',
      entityId: null,
      participantId: null,
    };
    const a = chainHash(GENESIS_HASH, { ...base, metadata: { b: 2, a: 1 } });
    const b = chainHash(GENESIS_HASH, { ...base, metadata: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
});
