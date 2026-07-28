import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, isInstalled } from './index.js';

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
    expect(platform.push).toBeDefined();
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

describe('WebPush', () => {
  it('reports unsupported without a service worker and PushManager', () => {
    expect(getPlatform().push.isSupported()).toBe(false);
    expect(getPlatform().push.permission()).toBe('unsupported');
  });

  it('returns null rather than throwing when there is nothing to subscribe to', async () => {
    // No support, no permission and no VAPID key are all ordinary states, and
    // none of them should stop a worker recording a check.
    await expect(getPlatform().push.subscribe('a-key')).resolves.toBeNull();
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
