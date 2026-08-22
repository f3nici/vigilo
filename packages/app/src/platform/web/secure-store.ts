import type { SecureStore, UnlockMethod } from '../types.js';

/**
 * PWA secure store: a key that only exists while the app is unlocked.
 *
 * The local database holds names, diary bodies and free-text values, and OPFS
 * is not encrypted on disk (doc 03 §12). So those columns are encrypted with a
 * key the app has to be unlocked to derive, and the threat this actually
 * defends against is an unlocked, stolen phone rather than a stolen file.
 *
 * Two ways to derive it:
 *
 * - **WebAuthn PRF.** A platform authenticator (Face ID, Touch ID, a
 *   fingerprint) returns the same 32 bytes for the same credential and salt,
 *   and only after a real user verification. Nothing that could reproduce the
 *   key is stored, so the phone's own biometric is the gate.
 * - **A PIN.** Where PRF is unavailable, which today is most of Safari, the
 *   key comes from PBKDF2 over a PIN and a stored random salt. Weaker, and
 *   worth being honest about: a six-digit PIN is brute-forceable by somebody
 *   who takes the device apart, which is why the iteration count is high and
 *   why the PRF path is preferred wherever the device offers it.
 *
 * Secrets are wrapped with that key and kept in IndexedDB. They are never
 * written in the clear, and the key never leaves this file.
 */

const DB_NAME = 'vigilo-secure';
const STORE = 'secrets';
const CREDENTIAL_KEY = 'webauthn.credential-id';
const SALT_KEY = 'kdf.salt';
const VERIFIER_KEY = 'kdf.verifier';

/** High enough to make a six-digit PIN expensive, low enough to unlock fast. */
const PBKDF2_ITERATIONS = 600_000;

/** Fixed, because PRF has to give the same bytes back on every unlock. */
const PRF_SALT = new TextEncoder().encode('vigilo.local-database.v1');

type PrfExtensionResults = { prf?: { results?: { first?: ArrayBuffer } } };

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable.'));
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not write to local storage.'));
  });
  db.close();
}

async function read<T>(key: string): Promise<T | null> {
  const db = await idb();
  const value = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('Could not read local storage.'));
  });
  db.close();
  return value;
}

async function drop(key: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not clear local storage.'));
  });
  db.close();
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** The PRF bytes, from either ceremony, or undefined where none came back. */
function prfOutput(credential: PublicKeyCredential): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs &
    PrfExtensionResults;
  return results.prf?.results?.first;
}

/**
 * Cancellation, or a fault worth saying out loud.
 *
 * The same split `ceremonyFailed` makes in `passkeys.ts`, for the same reason:
 * false here means "no biometric, offer the PIN", which is the right answer to
 * somebody dismissing the prompt and the wrong answer to a browser that cannot
 * run the ceremony at all. Both used to arrive as a bare `catch { return false }`,
 * so a real fault was a button that quietly took its own offer away.
 *
 * This one returns rather than throws, because unlocking has a working second
 * route. The screen falls back to the PIN either way; the console gets the
 * detail so the next person to look has something to go on.
 */
function unlockCeremonyFailed(ceremony: 'create' | 'get', error: unknown): false {
  const name = error instanceof DOMException ? error.name : '';

  if (name !== 'NotAllowedError' && name !== 'AbortError') {
    console.error(`biometric unlock ${ceremony} failed`, error);
  }

  return false;
}

export class WebSecureStore implements SecureStore {
  /** Held in memory for the session only. Never persisted, never exported. */
  #key: CryptoKey | null = null;
  #method: UnlockMethod | null = null;

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
      return false;
    }
    try {
      return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  isUnlocked(): boolean {
    return this.#key !== null;
  }

  method(): UnlockMethod | null {
    return this.#method;
  }

  async isEnrolled(): Promise<boolean> {
    return (await read<string>(CREDENTIAL_KEY)) !== null || (await read<string>(SALT_KEY)) !== null;
  }

  async enrolledMethod(): Promise<UnlockMethod | null> {
    if ((await read<string>(CREDENTIAL_KEY)) !== null) return 'biometric';
    if ((await read<string>(SALT_KEY)) !== null) return 'pin';
    return null;
  }

  /* ------------------------------------------------------------- enrolment */

  /**
   * Returns false rather than throwing when the device cannot do it.
   *
   * PRF support cannot be detected in advance: an authenticator can register
   * happily and then report no PRF results. So enrolment tries, and a false
   * here is the install flow's signal to offer the PIN instead.
   *
   * The one place it must not be tested is registration. Android's Google
   * Password Manager writes the passkey, reports no `prf` at all on the way
   * back, and then answers PRF perfectly on the next assertion. Reading the
   * creation results as the verdict called every Android device incapable
   * after putting a real passkey in the person's keychain, which is what the
   * fingerprint button did on a Pixel: a Google prompt, then the offer gone.
   *
   * So registration only registers. `first` is asked for here because a
   * browser that does answer saves a second prompt, and everything else waits
   * for the assertion, where the answer is trustworthy.
   */
  async enrolBiometric(userId: string, userName: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'Vigilo', id: window.location.hostname },
          user: {
            id: new TextEncoder().encode(userId),
            name: userName,
            displayName: userName,
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'required',
            userVerification: 'required',
          },
          extensions: {
            prf: { eval: { first: PRF_SALT } },
          } as AuthenticationExtensionsClientInputs,
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
    } catch (error) {
      return unlockCeremonyFailed('create', error);
    }

    if (!credential) return false;

    const credentialId = toBase64(credential.rawId);
    const first = prfOutput(credential);

    // Where the browser answered, the key is already here and the person was
    // prompted once.
    if (first !== undefined) {
      await this.#adopt(first);
      await put(CREDENTIAL_KEY, credentialId);
      return true;
    }

    // Where it did not, ask for an assertion now. This is the second prompt on
    // Android, and it is the only honest test of whether the credential can
    // produce a key at all.
    await put(CREDENTIAL_KEY, credentialId);
    if (await this.#deriveFrom(credentialId)) return true;

    // It registered and cannot do PRF. Leaving the id behind would make
    // `enrolledMethod` answer 'biometric' for a credential that unlocks
    // nothing, so the offer would come back on the lock screen and fail there
    // instead. Only this key is dropped: a PIN set up earlier is untouched.
    await drop(CREDENTIAL_KEY);
    return false;
  }

  /** Turns PRF output into the session key. The slice is the AES-256 length. */
  async #adopt(first: ArrayBuffer): Promise<void> {
    this.#key = await keyFromBytes(bytes(first).slice(0, 32));
    this.#method = 'biometric';
  }

  /**
   * One assertion against a known credential, which is where PRF answers.
   *
   * Shared by enrolment and unlock so there is one description of what a
   * working biometric looks like, rather than two that can drift.
   */
  async #deriveFrom(credentialId: string): Promise<boolean> {
    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: fromBase64(credentialId) }],
          userVerification: 'required',
          extensions: {
            prf: { eval: { first: PRF_SALT } },
          } as AuthenticationExtensionsClientInputs,
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
    } catch (error) {
      return unlockCeremonyFailed('get', error);
    }

    if (!assertion) return false;

    const first = prfOutput(assertion);
    if (first === undefined) return false;

    await this.#adopt(first);
    return true;
  }

  async enrolPin(pin: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveFromPin(pin, salt);

    await put(SALT_KEY, toBase64(salt.buffer as ArrayBuffer));
    // A verifier, so a wrong PIN is reported as a wrong PIN rather than as a
    // database full of values that will not decrypt.
    await put(VERIFIER_KEY, await sealWith(key, 'vigilo'));

    this.#key = key;
    this.#method = 'pin';
  }

  /* ---------------------------------------------------------------- unlock */

  async unlockWithBiometric(): Promise<boolean> {
    const credentialId = await read<string>(CREDENTIAL_KEY);
    if (credentialId === null) return false;
    return await this.#deriveFrom(credentialId);
  }

  async unlockWithPin(pin: string): Promise<boolean> {
    const salt = await read<string>(SALT_KEY);
    const verifier = await read<string>(VERIFIER_KEY);
    if (salt === null || verifier === null) return false;

    const key = await deriveFromPin(pin, bytes(fromBase64(salt)));
    try {
      if ((await openWith(key, verifier)) !== 'vigilo') return false;
    } catch {
      return false;
    }

    this.#key = key;
    this.#method = 'pin';
    return true;
  }

  lock(): void {
    this.#key = null;
    this.#method = null;
  }

  /* -------------------------------------------------------------- the data */

  async set(key: string, value: string): Promise<void> {
    await put(key, await sealWith(this.#require(), value));
  }

  async get(key: string): Promise<string | null> {
    const sealed = await read<string>(key);
    if (sealed === null) return null;
    try {
      return await openWith(this.#require(), sealed);
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await drop(key);
  }

  /**
   * Sealing and opening one value, for the local database's own columns.
   *
   * Exposed here rather than handing the key out, because the key never leaves
   * this file. The layer above asks for a value to be sealed and gets back
   * something it cannot open on its own.
   */
  async seal(value: string): Promise<string> {
    return sealWith(this.#require(), value);
  }

  async unseal(sealed: string): Promise<string> {
    return openWith(this.#require(), sealed);
  }

  /** Forgets the enrolment entirely. Sign-out on a shared device. */
  async reset(): Promise<void> {
    this.lock();
    for (const key of [CREDENTIAL_KEY, SALT_KEY, VERIFIER_KEY]) await drop(key);
  }

  #require(): CryptoKey {
    if (!this.#key) throw new Error('Vigilo is locked.');
    return this.#key;
  }
}

async function keyFromBytes(material: Uint8Array): Promise<CryptoKey> {
  // PRF output and PBKDF2 output are both 32 bytes of key material, so both
  // arrive here and nothing above can tell which was used.
  return crypto.subtle.importKey('raw', material as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

async function deriveFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `nonce | ciphertext`, base64. The same layout the API uses for a file. */
async function sealWith(key: CryptoKey, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      key,
      new TextEncoder().encode(value) as BufferSource,
    ),
  );

  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce);
  packed.set(ciphertext, nonce.length);
  return toBase64(packed.buffer as ArrayBuffer);
}

async function openWith(key: CryptoKey, sealed: string): Promise<string> {
  const packed = bytes(fromBase64(sealed));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, 12) as BufferSource },
    key,
    packed.slice(12) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out.buffer;
}
