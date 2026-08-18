import type { QuickSignInMethod } from '@vigilo/shared';
import { getPlatform } from '@/platform';
import * as api from '@/api/client';

/**
 * Quick sign-in, from the device's side (#24).
 *
 * The server issues a secret to a session that already exists. This seals it
 * with the same key the local database is encrypted under, so the fingerprint
 * or the PIN that unlocks the records is the same one that gets back in, and
 * there is not a second thing to set up and a second thing to forget.
 *
 * What is sealed and what is not:
 *
 * - The **secret** is sealed, always. It is the whole credential, and an
 *   unsealed copy sitting in IndexedDB would make the fingerprint decorative.
 * - The **credential id** is a plain uuid in local storage, because the sign-in
 *   screen has to know there is something to offer before anything is
 *   unlocked. It identifies a row; it opens nothing.
 *
 * The pairing matters more than either half. Signing out clears both, and so
 * does a failed redemption: a secret the server has retired is worse than no
 * secret, because it offers a button that cannot work.
 */

const LOCAL_KEY = 'vigilo.quick-sign-in';
const SECRET_KEY = 'quick-sign-in.secret';

export type LocalQuickSignIn = {
  credentialId: string;
  method: QuickSignInMethod;
  label: string;
};

export function localQuickSignIn(): LocalQuickSignIn | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LocalQuickSignIn>;
    if (typeof parsed.credentialId !== 'string') return null;
    return {
      credentialId: parsed.credentialId,
      method: parsed.method === 'biometric' ? 'biometric' : 'pin',
      label: typeof parsed.label === 'string' ? parsed.label : 'This device',
    };
  } catch {
    return null;
  }
}

/**
 * Sets it up. The secure store has to be unlocked, because sealing the secret
 * is the point: it is what makes the unlock the gate rather than the decoration.
 */
export async function enableQuickSignIn(
  method: QuickSignInMethod,
  label: string,
): Promise<LocalQuickSignIn> {
  const secureStore = getPlatform().secureStore;
  if (!secureStore.isUnlocked()) {
    throw new Error('Set up a PIN or a fingerprint on this device first.');
  }

  const credential = await api.enrolQuickSignIn(method, label);
  await secureStore.set(SECRET_KEY, credential.secret);

  const local: LocalQuickSignIn = { credentialId: credential.credentialId, method, label };
  localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  return local;
}

/**
 * Signs in with the sealed secret, after an unlock has released the key.
 *
 * Returns false when there is nothing to redeem or the server has retired it,
 * and forgets it in the second case. The caller falls back to the password
 * field it was already showing, which is why this returns rather than throws.
 */
export async function signInWithQuickCredential(): Promise<boolean> {
  const local = localQuickSignIn();
  if (local === null) return false;

  const secret = await getPlatform().secureStore.get(SECRET_KEY);
  if (secret === null) return false;

  try {
    await api.quickSignIn(local.credentialId, secret);
    return true;
  } catch (error) {
    // A credential the server no longer honours is worse than none: it offers
    // a button that cannot work. Anything else, including no signal, leaves it
    // alone so it still works when the connection comes back.
    if (error instanceof api.ApiRequestError && error.code === 'unauthenticated') {
      await forgetQuickSignIn();
    }
    throw error;
  }
}

/** Locally only. Use `removeQuickSignIn` as well to retire the server's row. */
export async function forgetQuickSignIn(): Promise<void> {
  localStorage.removeItem(LOCAL_KEY);
  try {
    await getPlatform().secureStore.remove(SECRET_KEY);
  } catch {
    // Removing a key that is not there, or an IndexedDB that has gone. Either
    // way the credential id is what the sign-in screen reads, and that is gone.
  }
}

/* ------------------------------------------------------------------ passkeys */

/**
 * Registering a passkey on this account.
 *
 * Returns false when the person dismissed the prompt, which is not a failure
 * and gets no error message.
 */
export async function addPasskey(name: string): Promise<boolean> {
  const options = await api.passkeyRegistrationOptions();
  const credential = await getPlatform().passkeys.create(options);
  if (credential === null) return false;

  await api.registerPasskey(name, credential);
  return true;
}

export async function signInWithPasskey(): Promise<boolean> {
  const options = await api.passkeySignInOptions();
  const credential = await getPlatform().passkeys.get(options);
  if (credential === null) return false;

  await api.passkeyLogin(credential);
  return true;
}
