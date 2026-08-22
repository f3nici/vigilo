import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  describeSyncState,
  syncIndicatorState,
  type OutboxOperation,
  type SyncStatus,
} from '@vigilo/shared';
import { getPlatform, isInstalled, type StorageUnavailable } from '@/platform';
import { LocalStore } from '@/db/local';
import { SyncEngine } from '@/sync/engine';
import { uuidv7 } from '@/lib/uuid';
import { useSessionStore } from '@/stores/session';
import * as api from '@/api/client';

/**
 * Offline: the local database, the unlock, and everything that makes sync
 * happen (doc 05).
 *
 * One store owns all three because they are one lifecycle. There is no local
 * database without an unlock to derive its key, no sync without a database to
 * apply it to, and nothing to unlock before somebody has signed in.
 */

const DEVICE_ID_KEY = 'vigilo.device-id';

/** Sync while the app is in front, every five minutes (doc 05 §4). */
const TIMER_MS = 5 * 60 * 1000;

export type OfflineState =
  | 'idle'
  | 'locked'
  | 'ready'
  | 'unavailable'
  /** Another tab holds the database. Not an error, just the second tab. */
  | 'busy';

export const useOfflineStore = defineStore('offline', () => {
  const platform = getPlatform();

  const state = ref<OfflineState>('idle');
  const unavailableReason = ref<StorageUnavailable | null>(null);
  const detail = ref('');

  const store = shallowRef<LocalStore | null>(null);
  const engine = shallowRef<SyncEngine | null>(null);

  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
  const syncing = ref(false);
  const lastError = ref('');
  const wasEvicted = ref(false);

  const pendingCount = ref(0);
  const needsUserCount = ref(0);
  const oldestPendingAt = ref<string | null>(null);
  const lastSyncAt = ref<string | null>(null);
  const persisted = ref(false);

  let timer: ReturnType<typeof setInterval> | null = null;
  let listening = false;

  const status = computed<SyncStatus>(() => ({
    online: online.value,
    pendingCount: pendingCount.value,
    needsUserCount: needsUserCount.value,
    oldestPendingAt: oldestPendingAt.value,
    lastSyncAt: lastSyncAt.value,
  }));

  const indicator = computed(() => syncIndicatorState(status.value, new Date()));
  const indicatorText = computed(() => describeSyncState(status.value, new Date()));

  /** A tab has no reliable offline storage and, on iOS, no push (doc 05 §10). */
  const installed = computed(() => isInstalled());

  /**
   * The device's own id, generated once and kept.
   *
   * In localStorage rather than the local database, because the id has to
   * survive the database being wiped: it is what a push subscription and a
   * remote wipe flag refer to.
   */
  function deviceId(): string {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing !== null) return existing;
    const created = uuidv7();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  }

  /* --------------------------------------------------------------- unlock */

  const secureStore = platform.secureStore;

  async function enrolmentState(): Promise<{ enrolled: boolean; biometric: boolean }> {
    return {
      enrolled: await secureStore.isEnrolled(),
      biometric: await secureStore.isAvailable(),
    };
  }

  async function unlockWithBiometric(): Promise<boolean> {
    if (!(await secureStore.unlockWithBiometric())) return false;
    await afterUnlock();
    return true;
  }

  async function unlockWithPin(pin: string): Promise<boolean> {
    if (!(await secureStore.unlockWithPin(pin))) return false;
    await afterUnlock();
    return true;
  }

  async function enrolBiometric(userId: string, userName: string): Promise<boolean> {
    if (!(await secureStore.enrolBiometric(userId, userName))) return false;
    // Enrolment now returns only once it holds the key, so asking for another
    // assertion here would be a second fingerprint prompt for nothing. It can
    // still arrive locked from a platform that enrols without deriving, and
    // that is what the unlock is for.
    if (secureStore.isUnlocked()) {
      await afterUnlock();
      return true;
    }
    return unlockWithBiometric();
  }

  async function enrolPin(pin: string): Promise<void> {
    await secureStore.enrolPin(pin);
    await afterUnlock();
  }

  function lock(): void {
    secureStore.lock();
    state.value = 'locked';
  }

  /* ------------------------------------------------------------ the database */

  /**
   * Opens the local database and starts syncing.
   *
   * Called after sign-in and after an unlock. Everything it does is safe to
   * repeat, because a reload, a second tab and a returning background task all
   * arrive here.
   */
  async function start(userId: string): Promise<void> {
    if (!secureStore.isUnlocked()) {
      state.value = (await secureStore.isEnrolled()) ? 'locked' : 'idle';
      return;
    }

    if (store.value === null) {
      const opened = await platform.storage.open();
      if (!opened.ok) {
        state.value = opened.reason === 'busy' ? 'busy' : 'unavailable';
        unavailableReason.value = opened.reason;
        detail.value = opened.detail;
        return;
      }

      const local = new LocalStore(opened.database, secureStore);
      await local.migrate();

      /*
       * A database belonging to somebody else is thrown away rather than
       * merged. Two workers share a phone on a handover, and the second must
       * never see the first's participants.
       */
      const owner = await local.userId();
      if (owner !== null && owner !== userId) {
        await local.wipe();
      }
      await local.claimFor(userId);

      store.value = local;
      engine.value = new SyncEngine(local);
    }

    api.setDeviceId(deviceId());
    state.value = 'ready';

    await registerDevice();
    await refreshStatus();

    /*
     * An empty database with a live session means the browser threw our data
     * away, which on iOS happens after about seven days unused. Saying so is
     * the point: an empty Today screen looks exactly like data loss, and a
     * worker who thinks their records are gone stops trusting the app
     * (doc 05 §8.1).
     */
    if (await store.value.isEmpty()) {
      wasEvicted.value = (await store.value.cursor()) > 0;
    }

    listen();
    await sync();
  }

  /**
   * Who just unlocked, without asking the server.
   *
   * The session store already knows, from this session or from the last one it
   * cached. Asking the API here would mean an unlock that only works with
   * signal, which is the one situation the unlock exists for.
   */
  async function afterUnlock(): Promise<void> {
    const session = useSessionStore();
    await session.ensureLoaded();
    const userId = session.principal?.userId;
    if (userId !== undefined) await start(userId);
  }

  async function registerDevice(): Promise<void> {
    try {
      const device = await api.registerDevice({
        deviceId: deviceId(),
        platform: 'web',
        model: null,
        osVersion: null,
        appVersion: null,
        installed: installed.value,
      });

      // A device flagged for wipe drops everything it holds, after pushing
      // whatever it has not sent yet (doc 03 §2).
      if (device.wipeRequested) await wipe();
    } catch {
      // Offline. The device row already exists from a previous run, or it will
      // be created on the first pass with signal. Not worth blocking on.
    }
  }

  /* ----------------------------------------------------------------- sync */

  async function sync(): Promise<void> {
    if (engine.value === null || syncing.value) return;

    syncing.value = true;
    try {
      const outcome = await engine.value.sync();
      lastError.value = outcome.error ?? '';
      if (outcome.bootstrapped) wasEvicted.value = false;
    } finally {
      syncing.value = false;
      await refreshStatus();
    }
  }

  async function refreshStatus(): Promise<void> {
    if (store.value === null) return;
    const outbox = await store.value.outboxStatus();
    pendingCount.value = outbox.pendingCount;
    needsUserCount.value = outbox.needsUserCount;
    oldestPendingAt.value = outbox.oldestPendingAt;
    lastSyncAt.value = await store.value.lastSyncAt();
    persisted.value = await platform.storage.isPersisted();
  }

  /**
   * Queues a local write and syncs immediately.
   *
   * "Immediately after any local write" is one of the triggers doc 05 §8.2
   * names, and the one that matters most: the correct outbox depth is zero,
   * and every minute a record sits here is a minute iOS could evict it.
   */
  async function enqueue(operation: OutboxOperation): Promise<void> {
    if (store.value === null) return;
    await store.value.enqueue(operation);
    await refreshStatus();
    void sync();
  }

  async function queuePhoto(input: {
    attachmentId: string;
    participantId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<void> {
    if (store.value === null) return;
    await store.value.enqueueAttachment(input);
    await refreshStatus();
    void sync();
  }

  /** Everything the server has refused, for the screen that lists them. */
  async function flagged() {
    return store.value?.flaggedOperations() ?? [];
  }

  /* ---------------------------------------------------------------- wipe */

  /**
   * Sign-out, suspension, or a remote wipe.
   *
   * The outbox is flushed first, always. Wiping records a worker made and the
   * server has never seen would destroy the only copy that exists.
   */
  async function wipe(): Promise<void> {
    if (store.value === null) return;
    try {
      await engine.value?.push();
    } catch {
      // No signal. The records are lost either way at this point, and the
      // wipe is not optional: it exists because access was withdrawn.
    }
    await store.value.wipe();
    await refreshStatus();
  }

  async function signOut(): Promise<void> {
    await wipe();
    await store.value?.close();
    store.value = null;
    engine.value = null;
    secureStore.lock();
    state.value = 'idle';
    stopListening();
  }

  /* -------------------------------------------------------------- triggers */

  /**
   * Every trigger doc 05 §8.2 names, and no reliance on any single one.
   *
   * Background Sync exists on Android and never on iOS, so it is registered
   * where available and treated as a bonus. What actually keeps the queue
   * empty is the app coming to the front, which workers do every two hours by
   * definition.
   */
  function listen(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);

    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void sync();
    }, TIMER_MS);
  }

  function stopListening(): void {
    if (!listening || typeof window === 'undefined') return;
    listening = false;

    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);

    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function onOnline(): void {
    online.value = true;
    void sync();
  }

  function onOffline(): void {
    online.value = false;
  }

  function onVisible(): void {
    if (document.visibilityState === 'visible') void sync();
  }

  function onServiceWorkerMessage(event: MessageEvent): void {
    if ((event.data as { type?: string } | undefined)?.type === 'SYNC_NOW') void sync();
  }

  return {
    state,
    unavailableReason,
    detail,
    online,
    syncing,
    lastError,
    wasEvicted,
    persisted,
    installed,
    status,
    indicator,
    indicatorText,
    pendingCount,
    needsUserCount,
    lastSyncAt,
    localStore: store,

    deviceId,
    enrolmentState,
    enrolBiometric,
    enrolPin,
    unlockWithBiometric,
    unlockWithPin,
    lock,
    start,
    sync,
    refreshStatus,
    enqueue,
    queuePhoto,
    flagged,
    wipe,
    signOut,
  };
});
