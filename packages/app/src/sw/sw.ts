/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import type { WorkboxPlugin } from 'workbox-core';

/**
 * The service worker (doc 05 §8.2, doc 09 Phase 5).
 *
 * Three jobs and no more: serve the shell offline, deliver push notifications,
 * and hand an update to the page rather than applying one itself.
 *
 * It deliberately does not cache API responses. Everything a worker reads
 * offline comes out of the local SQLite database, which knows what is stale and
 * what has been superseded. A cache in front of the API would be a second,
 * dumber copy of the same data, and the two would disagree about a participant
 * somebody has just been unassigned from.
 */

declare const self: ServiceWorkerGlobalScope;

type PushPayload = {
  kind: string;
  title: string;
  body: string;
  url: string;
  tag: string;
};

/* --------------------------------------------------------------- the shell */

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

/**
 * Every navigation gets index.html, which is what makes the app open at all
 * with no signal. `/api` is excluded: a failed API call must fail, not come
 * back as an HTML page the client cannot parse.
 */
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      const cached = await caches.match('/index.html', { ignoreSearch: true });
      return cached ?? fetch(request);
    },
    { denylist: [/^\/api\//] },
  ),
);

/** The API is never cached, at any layer. */
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

/**
 * Startup images, cached on use rather than precached. A phone needs one of
 * the thirty and only finds out which when it launches.
 */
registerRoute(
  ({ url }) => url.pathname.startsWith('/splash/'),
  new CacheFirst({
    cacheName: 'vigilo-splash',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 4,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }) as WorkboxPlugin,
    ],
  }),
);

/* -------------------------------------------------------------- the update */

/**
 * A new build never takes over on its own.
 *
 * "Never interrupt an entry in progress" (doc 06 §7) is the rule, and a service
 * worker that calls skipWaiting on install reloads the page under a worker who
 * is half way through typing observations. So the new worker waits, the page
 * is told, and the page decides when it is safe. `SKIP_WAITING` is that
 * decision arriving.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

/* ---------------------------------------------------------------- the push */

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;

  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    // Never render a payload we cannot read. A notification that says
    // "undefined" about a person's care is worse than no notification.
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Tagged by subject, so a second reminder about the same window replaces
      // the first instead of stacking up a column of them.
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/monochrome-512.png',
      data: { url: payload.url },
      requireInteraction: false,
    }),
  );
});

/**
 * Tapping a notification goes to the record it is about, reusing an open
 * window rather than opening a second one. A worker with two copies of the app
 * running is a worker who can lose an entry to the wrong tab.
 */
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/today';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'NAVIGATE', url: target });
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});

/* ------------------------------------------------------------ background sync */

/**
 * Android and desktop Chromium give us this. iOS does not, and never will, so
 * nothing depends on it: this only asks the page to sync sooner than it
 * otherwise would (doc 05 §8.2).
 */
self.addEventListener('sync', ((event: ExtendableEvent & { tag: string }) => {
  if (event.tag !== 'vigilo-outbox') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.postMessage({ type: 'SYNC_NOW' });
    })(),
  );
}) as EventListener);
