import { afterEach, describe, expect, it, vi } from 'vitest';
import { canOfferBiometric, getPlatform, isHandheld, isInstalled } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPlatform', () => {
  it('returns the web adapters, which is all the PWA has', () => {
    const platform = getPlatform();
    expect(platform.name).toBe('web');
    expect(platform.storage).toBeDefined();
    expect(platform.secureStore).toBeDefined();
  });
});

describe('WebStorage', () => {
  it('reports OPFS as unavailable when the browser has no getDirectory', () => {
    expect(getPlatform().storage.isAvailable()).toBe(false);
  });

  it('reports OPFS as available when the browser has it', () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    // A worker as well as OPFS: Safari only hands synchronous access handles
    // to a worker, so OPFS on its own is not enough to open the database.
    vi.stubGlobal('Worker', class {});
    expect(getPlatform().storage.isAvailable()).toBe(true);
  });

  it('reports it unavailable without a worker, even with OPFS', () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    vi.stubGlobal('Worker', undefined);
    expect(getPlatform().storage.isAvailable()).toBe(false);
  });

  it('returns false rather than throwing when persist is refused', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: () => Promise.reject(new Error('nope')) },
    });
    await expect(getPlatform().storage.requestPersistence()).resolves.toBe(false);
  });

  it('explains why the local database is unavailable rather than throwing', async () => {
    // A browser with no OPFS is a normal situation with something sensible to
    // say about it, not an exception for a caller to catch.
    const result = await getPlatform().storage.open();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unsupported');
    expect(result.ok === false && result.detail.length).toBeGreaterThan(0);
  });
});

describe('WebSecureStore', () => {
  it('reports no biometric unlock without WebAuthn', async () => {
    await expect(getPlatform().secureStore.isAvailable()).resolves.toBe(false);
  });

  it('refuses to seal anything before an unlock', async () => {
    await expect(getPlatform().secureStore.seal('anything')).rejects.toThrow('locked');
  });

  it('is not unlocked before anybody has unlocked it', () => {
    expect(getPlatform().secureStore.isUnlocked()).toBe(false);
    expect(getPlatform().secureStore.method()).toBeNull();
  });
});

describe('WebPasskeys', () => {
  it('reports no support at all without WebAuthn', async () => {
    await expect(getPlatform().passkeys.availability()).resolves.toEqual({
      supported: false,
      platformAuthenticator: false,
    });
  });

  it('still reports support when the platform check throws', async () => {
    // A browser with the object and no answer can still use a security key,
    // so this is not "no passkeys here".
    vi.stubGlobal('window', {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error('nope')),
      },
    });

    await expect(getPlatform().passkeys.availability()).resolves.toEqual({
      supported: true,
      platformAuthenticator: false,
    });
  });
});

describe('who gets offered biometric sign-in', () => {
  /** Installed, handheld and a platform authenticator, all three (#24). */
  function browser(options: {
    installed: boolean;
    coarse: boolean;
    touch: number;
    authenticator: boolean;
  }): void {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({
        matches: query.includes('standalone') ? options.installed : options.coarse,
      }),
      navigator: { maxTouchPoints: options.touch },
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(options.authenticator),
      },
    });
    vi.stubGlobal('navigator', { maxTouchPoints: options.touch });
  }

  it('is offered on an installed phone with a fingerprint reader', async () => {
    browser({ installed: true, coarse: true, touch: 5, authenticator: true });
    await expect(canOfferBiometric()).resolves.toBe(true);
  });

  it('is not offered in a browser tab, however capable the phone is', async () => {
    // A fingerprint that unlocks a tab somebody opened once is a credential
    // sitting in a tab nobody will close.
    browser({ installed: false, coarse: true, touch: 5, authenticator: true });
    await expect(canOfferBiometric()).resolves.toBe(false);
  });

  it('is not offered on a desktop with a fingerprint reader', async () => {
    // Often a shared machine in an office, where it is the wrong offer even
    // where it works. The PIN is offered wherever this is not.
    browser({ installed: true, coarse: false, touch: 0, authenticator: true });
    await expect(canOfferBiometric()).resolves.toBe(false);
    expect(isHandheld()).toBe(false);
  });

  it('is not offered where the device has no platform authenticator', async () => {
    browser({ installed: true, coarse: true, touch: 5, authenticator: false });
    await expect(canOfferBiometric()).resolves.toBe(false);
  });
});

describe('isInstalled', () => {
  it('is false in a plain browser tab', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      navigator: {},
    });
    expect(isInstalled()).toBe(false);
  });

  it('is true in a standalone display mode', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query.includes('standalone') }),
      navigator: {},
    });
    expect(isInstalled()).toBe(true);
  });

  it('is true on iOS, which has no display-mode media query for home-screen apps', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: true },
    });
    expect(isInstalled()).toBe(true);
  });
});
