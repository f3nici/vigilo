import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, isInstalled, PlatformNotImplementedError } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPlatform', () => {
  it('returns the web adapters, which is all Phase 0 ships', () => {
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
    expect(getPlatform().storage.isAvailable()).toBe(true);
  });

  it('returns false rather than throwing when persist is refused', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: () => Promise.reject(new Error('nope')) },
    });
    await expect(getPlatform().storage.requestPersistence()).resolves.toBe(false);
  });

  it('defers the local database to Phase 5 with a clear error', async () => {
    await expect(getPlatform().storage.open()).rejects.toBeInstanceOf(PlatformNotImplementedError);
  });
});

describe('WebSecureStore', () => {
  it('reports no biometric unlock without WebAuthn', async () => {
    await expect(getPlatform().secureStore.isAvailable()).resolves.toBe(false);
  });

  it('defers token storage to Phase 5', async () => {
    await expect(getPlatform().secureStore.get('refresh')).rejects.toBeInstanceOf(
      PlatformNotImplementedError,
    );
  });
});

describe('WebPush', () => {
  it('reports unsupported without a service worker and PushManager', () => {
    expect(getPlatform().push.isSupported()).toBe(false);
    expect(getPlatform().push.permission()).toBe('unsupported');
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
