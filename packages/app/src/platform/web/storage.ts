import { PlatformNotImplementedError, type Storage, type StorageEstimate } from '../types.js';

/**
 * PWA storage: SQLite-WASM over OPFS in a worker thread (Phase 5).
 *
 * Phase 0 wires the capability and durability side, which is the part the
 * install flow needs, and leaves the database itself to Phase 5.
 */
export class WebStorage implements Storage {
  isAvailable(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage !== 'undefined' &&
      typeof navigator.storage.getDirectory === 'function'
    );
  }

  async requestPersistence(): Promise<boolean> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
      return false;
    }
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  async isPersisted(): Promise<boolean> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persisted !== 'function') {
      return false;
    }
    try {
      return await navigator.storage.persisted();
    } catch {
      return false;
    }
  }

  async estimate(): Promise<StorageEstimate | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
      return null;
    }
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usageBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? 0,
      };
    } catch {
      return null;
    }
  }

  open(): Promise<unknown> {
    return Promise.reject(new PlatformNotImplementedError('The local SQLite database', 'Phase 5'));
  }
}
