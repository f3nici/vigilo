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

export type SqlStatement = {
  sql: string;
  params?: readonly unknown[];
};

/**
 * The local database, as everything above the platform boundary sees it.
 *
 * Deliberately SQL rather than a query builder or a key-value shape. The same
 * statements run against SQLite-WASM now and Capacitor SQLite in the native
 * phases, which is the whole reason doc 05 §8 chose SQLite on both platforms:
 * the schema, the migrations and every query are written once.
 */
export interface LocalDatabase {
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  run(sql: string, params?: readonly unknown[]): Promise<void>;

  /**
   * Several statements in one transaction, committed together or not at all.
   *
   * A sync page is applied through this. The cursor advances only after the
   * transaction commits, so an interrupted sync replays the page rather than
   * skipping half of it (doc 05 §4).
   */
  transaction(statements: readonly SqlStatement[]): Promise<void>;

  close(): Promise<void>;

  /** Deletes the whole local database. Sign-out, wipe, and eviction recovery. */
  wipe(): Promise<void>;
}

/**
 * Why the local database is not available.
 *
 * `busy` is its own case because it is not a failure: another tab holds the
 * database, and the honest thing to tell the user is that this tab is the
 * second one, not that something is broken.
 */
export type StorageUnavailable = 'unsupported' | 'busy' | 'failed';

export type OpenResult =
  { ok: true; database: LocalDatabase } | { ok: false; reason: StorageUnavailable; detail: string };

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

  /**
   * Opens the local database, or explains why it could not.
   *
   * Never throws for an expected condition. A browser with no OPFS and a
   * second tab that lost the race are both normal situations the app has
   * something sensible to say about.
   */
  open(): Promise<OpenResult>;
}

export type UnlockMethod = 'biometric' | 'pin';

/**
 * The key the local database's sensitive columns are encrypted with, and the
 * unlock that produces it.
 *
 * WebAuthn PRF on the PWA, the platform keystore on native, with a device PIN
 * as the fallback on both. The key itself is never handed out: callers ask for
 * a value to be sealed or opened, which is what keeps it inside the adapter
 * and out of the rest of the app.
 */
export interface SecureStore {
  /** Whether a platform authenticator (Face ID, Touch ID, fingerprint) exists. */
  isAvailable(): Promise<boolean>;

  /** Whether an unlock has been set up on this device at all. */
  isEnrolled(): Promise<boolean>;

  enrolledMethod(): Promise<UnlockMethod | null>;

  /** False when the device cannot derive a key this way. Offer the PIN then. */
  enrolBiometric(userId: string, userName: string): Promise<boolean>;

  enrolPin(pin: string): Promise<void>;

  unlockWithBiometric(): Promise<boolean>;

  unlockWithPin(pin: string): Promise<boolean>;

  isUnlocked(): boolean;

  method(): UnlockMethod | null;

  lock(): void;

  /** Forgets the enrolment. Sign-out on a shared device. */
  reset(): Promise<void>;

  set(key: string, value: string): Promise<void>;

  get(key: string): Promise<string | null>;

  remove(key: string): Promise<void>;

  seal(value: string): Promise<string>;

  unseal(sealed: string): Promise<string>;
}

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** What the API stores so it can reach this device. */
export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
};

/**
 * Push notifications: overdue warnings, close notifications, escalations.
 * Nothing sensitive goes in a payload. An initial and surname is the ceiling.
 */
export interface Push {
  isSupported(): boolean;

  permission(): PushPermission;

  requestPermission(): Promise<PushPermission>;

  /**
   * Subscribes with the deployment's public key. Null when there is nothing to
   * do: no support, no permission, or no key configured on the server.
   */
  subscribe(applicationServerKey: string): Promise<PushSubscriptionKeys | null>;

  unsubscribe(): Promise<void>;
}

export interface PlatformAdapters {
  readonly name: 'web' | 'native';
  readonly storage: Storage;
  readonly secureStore: SecureStore;
  readonly push: Push;
}
