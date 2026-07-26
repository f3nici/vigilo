/**
 * The three platform adapters (doc 02 §1).
 *
 * Everything platform-specific sits behind these interfaces. The PWA
 * implements them with OPFS, WebAuthn and Web Push; the native phases
 * implement them with Capacitor SQLite, the Keychain and FCM/APNs. Nothing
 * else in the app knows which platform it is running on, which is what makes
 * the native phases an adapter swap instead of a rewrite.
 *
 * A lint rule enforces this: nothing outside src/platform may reference OPFS,
 * WebAuthn, Web Push or Capacitor directly.
 */

/** Thrown by an adapter method whose implementation lands in a later phase. */
export class PlatformNotImplementedError extends Error {
  constructor(what: string, phase: string) {
    super(`${what} is not implemented yet. It arrives in ${phase}.`);
    this.name = 'PlatformNotImplementedError';
  }
}

export type StorageEstimate = {
  usageBytes: number;
  quotaBytes: number;
};

/**
 * Durable local database. SQLite on both platforms, so the local schema,
 * migrations and queries are written once.
 */
export interface Storage {
  /** Whether durable local storage exists at all on this device. */
  isAvailable(): boolean;

  /**
   * Ask the browser to exempt our data from eviction. iOS can drop OPFS after
   * roughly 7 days unused, taking an unsent outbox with it, so the result is
   * shown to the user rather than swallowed (doc 05 §8.1).
   */
  requestPersistence(): Promise<boolean>;

  /** Whether storage is already marked persistent. */
  isPersisted(): Promise<boolean>;

  estimate(): Promise<StorageEstimate | null>;

  /** Opens the local database. Phase 5. */
  open(): Promise<unknown>;
}

/**
 * Where the rotating refresh token lives. Released by WebAuthn on the PWA and
 * by the biometric plugin on native, with a device PIN fallback.
 */
export interface SecureStore {
  /** Whether a platform authenticator (Face ID, Touch ID, fingerprint) exists. */
  isAvailable(): Promise<boolean>;

  /** Stores a secret behind the platform authenticator. Phase 5. */
  set(key: string, value: string): Promise<void>;

  /** Reads a secret, prompting for the platform authenticator. Phase 5. */
  get(key: string): Promise<string | null>;

  remove(key: string): Promise<void>;
}

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * Push notifications: overdue warnings, close notifications, escalations.
 * Nothing sensitive goes in a payload. An initial and surname is the ceiling.
 */
export interface Push {
  isSupported(): boolean;

  permission(): PushPermission;

  requestPermission(): Promise<PushPermission>;

  /** Subscribes and returns the token the API stores against the device. Phase 5. */
  subscribe(): Promise<string>;

  unsubscribe(): Promise<void>;
}

export interface PlatformAdapters {
  readonly name: 'web' | 'native';
  readonly storage: Storage;
  readonly secureStore: SecureStore;
  readonly push: Push;
}
