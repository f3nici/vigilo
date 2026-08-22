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
    expect(await store.enrolledMethod()).toBeNull();
  });

  it('will not open again with the PIN it was reset with', async () => {
    // What `lock()` does not do, and the reason removing quick sign-in left
    // the PIN still opening the app. Reset is what "remove this device" and
    // signing out both have to reach for.
    await store.enrolPin('123456');
    await store.reset();

    expect(await store.unlockWithPin('123456')).toBe(false);
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

/**
 * The biometric half, against a stubbed authenticator.
 *
 * The ceremonies themselves still belong to the browser pass. What is worth a
 * unit test is which ceremony's results decide the verdict, because getting
 * that wrong is invisible on a desktop and total on a phone: Android's Google
 * Password Manager registers the passkey, returns no PRF at all from
 * `create`, and answers correctly from `get`. Reading the creation results as
 * the answer failed every Pixel after making it a real passkey.
 */
describe('the secure store, on a biometric', () => {
  let store: WebSecureStore;
  let created: number;
  let asserted: number;

  const CREDENTIAL_ID = new Uint8Array([1, 2, 3, 4]).buffer;
  const PRF_BYTES = new Uint8Array(32).fill(7).buffer;

  /** Stands in for one authenticator, told when to answer PRF. */
  function authenticator(answers: { onCreate: boolean; onGet: boolean }): void {
    created = 0;
    asserted = 0;

    const credential = (prf: boolean) => ({
      rawId: CREDENTIAL_ID,
      getClientExtensionResults: () => (prf ? { prf: { results: { first: PRF_BYTES } } } : {}),
    });

    Object.defineProperty(window, 'PublicKeyCredential', {
      configurable: true,
      value: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true },
    });

    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => {
          created += 1;
          return credential(answers.onCreate);
        },
        get: async () => {
          asserted += 1;
          return credential(answers.onGet);
        },
      },
    });
  }

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('vigilo-secure');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    store = new WebSecureStore();
  });

  it('enrols when PRF only answers at the assertion, as Android does', async () => {
    authenticator({ onCreate: false, onGet: true });

    expect(await store.enrolBiometric('user-1', 'Aroha Smith')).toBe(true);
    expect(store.isUnlocked()).toBe(true);
    expect(store.method()).toBe('biometric');
    expect(await store.enrolledMethod()).toBe('biometric');
    expect(asserted).toBe(1);
  });

  it('enrols on one prompt where creation already answers PRF', async () => {
    authenticator({ onCreate: true, onGet: true });

    expect(await store.enrolBiometric('user-1', 'Aroha Smith')).toBe(true);
    expect(store.isUnlocked()).toBe(true);
    // The whole point of asking at creation: no second fingerprint prompt.
    expect(asserted).toBe(0);
    expect(created).toBe(1);
  });

  it('reads back a value sealed at enrolment after a biometric unlock', async () => {
    authenticator({ onCreate: false, onGet: true });
    await store.enrolBiometric('user-1', 'Aroha Smith');

    const sealed = await store.seal('Aroha Smith had a settled night.');
    store.lock();
    expect(store.isUnlocked()).toBe(false);

    expect(await store.unlockWithBiometric()).toBe(true);
    expect(await store.unseal(sealed)).toBe('Aroha Smith had a settled night.');
  });

  it('keeps no enrolment for an authenticator that never answers PRF', async () => {
    authenticator({ onCreate: false, onGet: false });

    expect(await store.enrolBiometric('user-1', 'Aroha Smith')).toBe(false);
    // Left behind, `enrolledMethod` would offer a biometric on the lock screen
    // that cannot produce a key, moving the dead end rather than removing it.
    expect(await store.enrolledMethod()).toBeNull();
    expect(store.isUnlocked()).toBe(false);
  });

  it('leaves a PIN set up earlier alone when the biometric cannot enrol', async () => {
    await store.enrolPin('123456');
    const sealed = await store.seal('Aroha Smith had a settled night.');

    authenticator({ onCreate: false, onGet: false });
    expect(await store.enrolBiometric('user-1', 'Aroha Smith')).toBe(false);

    store.lock();
    expect(await store.unlockWithPin('123456')).toBe(true);
    expect(await store.unseal(sealed)).toBe('Aroha Smith had a settled night.');
  });
});
