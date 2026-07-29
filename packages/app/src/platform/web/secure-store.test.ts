import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebSecureStore } from './secure-store';

/**
 * The PIN half of the unlock, against real WebCrypto (doc 03 §12).
 *
 * The WebAuthn half needs a virtual authenticator and is exercised in the
 * browser pass instead. What matters here is that a value sealed on this
 * device cannot be read without the PIN, because that is the only thing
 * standing between an unlocked stolen phone and a participant's diary.
 */
describe('the secure store', () => {
  let store: WebSecureStore;

  beforeEach(async () => {
    // A fresh IndexedDB per test, so an enrolment does not leak into the next.
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('vigilo-secure');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    store = new WebSecureStore();
  });

  it('starts locked and with nothing enrolled', async () => {
    expect(store.isUnlocked()).toBe(false);
    expect(await store.isEnrolled()).toBe(false);
  });

  it('unlocks after enrolling a PIN', async () => {
    await store.enrolPin('123456');
    expect(store.isUnlocked()).toBe(true);
    expect(store.method()).toBe('pin');
    expect(await store.isEnrolled()).toBe(true);
    expect(await store.enrolledMethod()).toBe('pin');
  });

  it('seals a value and reads it back', async () => {
    await store.enrolPin('123456');
    const sealed = await store.seal('Aroha Smith had a settled night.');

    expect(sealed).not.toContain('Aroha');
    expect(await store.unseal(sealed)).toBe('Aroha Smith had a settled night.');
  });

  it('produces different ciphertext for the same value twice', async () => {
    // A random nonce per value. Otherwise two identical diary entries would be
    // visibly identical on disk, which leaks more than it looks like.
    await store.enrolPin('123456');
    expect(await store.seal('same')).not.toBe(await store.seal('same'));
  });

  it('refuses to seal anything while locked', async () => {
    await store.enrolPin('123456');
    store.lock();

    expect(store.isUnlocked()).toBe(false);
    await expect(store.seal('anything')).rejects.toThrow('locked');
  });

  it('reads a value back after locking and unlocking with the same PIN', async () => {
    await store.enrolPin('123456');
    const sealed = await store.seal('a diary entry');
    store.lock();

    expect(await store.unlockWithPin('123456')).toBe(true);
    expect(await store.unseal(sealed)).toBe('a diary entry');
  });

  it('rejects the wrong PIN rather than returning unreadable rows', async () => {
    // Without the verifier, a wrong PIN would unlock into a database where
    // every row fails to decrypt, which looks like data loss rather than a
    // typo.
    await store.enrolPin('123456');
    store.lock();

    expect(await store.unlockWithPin('654321')).toBe(false);
    expect(store.isUnlocked()).toBe(false);
  });

  it('cannot read a value sealed under a different PIN', async () => {
    await store.enrolPin('123456');
    const sealed = await store.seal('a diary entry');

    await store.reset();
    await store.enrolPin('999999');

    await expect(store.unseal(sealed)).rejects.toThrow();
  });

  it('forgets the enrolment entirely on reset', async () => {
    await store.enrolPin('123456');
    await store.reset();

    expect(await store.isEnrolled()).toBe(false);
    expect(store.isUnlocked()).toBe(false);
  });

  it('stores a named secret sealed rather than in the clear', async () => {
    await store.enrolPin('123456');
    await store.set('refresh-token', 'a-secret-token');

    expect(await store.get('refresh-token')).toBe('a-secret-token');

    store.lock();
    // Locked, the value is there and unreadable, which is the point.
    expect(await store.get('refresh-token')).toBeNull();
  });
});
