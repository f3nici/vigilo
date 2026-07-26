import { PlatformNotImplementedError, type SecureStore } from '../types.js';

/**
 * PWA secure store: a WebAuthn-gated token in IndexedDB (Phase 5).
 *
 * Phase 0 answers only "can this device do it", which is what the sign-in
 * screen needs to decide between biometric unlock and the PIN fallback.
 */
export class WebSecureStore implements SecureStore {
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

  set(_key: string, _value: string): Promise<void> {
    return Promise.reject(new PlatformNotImplementedError('WebAuthn-gated storage', 'Phase 5'));
  }

  get(_key: string): Promise<string | null> {
    return Promise.reject(new PlatformNotImplementedError('WebAuthn-gated storage', 'Phase 5'));
  }

  remove(_key: string): Promise<void> {
    return Promise.reject(new PlatformNotImplementedError('WebAuthn-gated storage', 'Phase 5'));
  }
}
