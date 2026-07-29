import { ref, type Ref } from 'vue';

/**
 * Registering the service worker, and holding an update back until it is safe
 * to apply (doc 05 §10, doc 06 §7).
 *
 * A service worker that calls `skipWaiting` on install reloads the page under
 * whoever is using it. At 2am, half way through a set of observations, that is
 * a lost entry and a worker who stops trusting the app. So a waiting worker
 * only sets a flag, and the page applies it when the user says so or when
 * nothing is in progress.
 */

export const updateReady: Ref<boolean> = ref(false);
export const offlineReady: Ref<boolean> = ref(false);

/**
 * Set by any screen holding half-typed input.
 *
 * The update waits while this is true, however many times the user is asked.
 * Nothing else in the app is allowed to make that decision.
 */
export const entryInProgress: Ref<boolean> = ref(false);

let waiting: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  try {
    registration = await navigator.serviceWorker.register(
      import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js',
      { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' },
    );

    if (registration.active && !navigator.serviceWorker.controller) {
      offlineReady.value = true;
    }

    if (registration.waiting) markWaiting(registration.waiting);

    registration.addEventListener('updatefound', () => {
      const installing = registration?.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        if (installing.state !== 'installed') return;
        if (navigator.serviceWorker.controller) markWaiting(installing);
        else offlineReady.value = true;
      });
    });

    /*
     * One reload, and only after the new worker actually took over. Reloading
     * on `updatefound` would race the swap and hand the user the old bundle
     * again, which looks like the update failing.
     */
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    // Hourly, so a fix reaches a phone that stays open all shift.
    setInterval(() => void registration?.update(), 60 * 60 * 1000);
  } catch {
    // No service worker means no offline shell and no push. The app still
    // works online, and the install screen is where that gets explained.
  }
}

function markWaiting(worker: ServiceWorker): void {
  waiting = worker;
  updateReady.value = true;
}

/** Applies the waiting update. Refused while an entry is open. */
export function applyUpdate(): boolean {
  if (entryInProgress.value) return false;
  waiting?.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

/**
 * Asks the browser to drain the outbox in the background where it can.
 *
 * Android and desktop Chromium have Background Sync; iOS has none and never
 * will. Registering it is worth a line, and nothing depends on it firing
 * (doc 05 §8.2).
 */
export async function requestBackgroundSync(): Promise<void> {
  const withSync = registration as
    (ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }) | null;
  try {
    await withSync?.sync?.register('vigilo-outbox');
  } catch {
    // Unsupported or denied. Foreground sync is the primary path anyway.
  }
}
