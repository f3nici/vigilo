import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import { useSessionStore } from './stores/session';
import { useOfflineStore } from './stores/offline';
import { registerServiceWorker } from './sw/register';
import './styles/main.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

const theme = useThemeStore();
theme.apply();
theme.watchSystem();

// The router guard loads the session before the first navigation resolves, so
// a reload lands on the right screen rather than bouncing through sign-in.
app.mount('#app');

/**
 * Everything offline, started after mount.
 *
 * After, deliberately. Opening SQLite over OPFS takes a moment, and a worker
 * opening the app in a hallway should get the shell immediately and the
 * records a beat later, not a blank screen while a worker thread starts.
 */
void (async () => {
  await registerServiceWorker();

  const session = useSessionStore();
  await session.ensureLoaded();

  const userId = session.principal?.userId;
  if (userId === undefined) return;

  const offline = useOfflineStore();
  await offline.start(userId);

  // Locked means the records are on the device but unreadable until somebody
  // unlocks them, so that is where to go whatever screen the app opened on.
  if (offline.state === 'locked' && router.currentRoute.value.name !== 'unlock') {
    await router.replace({ name: 'unlock' });
  }
})();

/**
 * Tapping a notification while the app is already open. The service worker
 * focuses this window and posts the destination, rather than opening a second
 * copy of the app for the same worker to lose an entry in.
 */
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | undefined;
    if (data?.type === 'NAVIGATE' && typeof data.url === 'string') {
      void router.push(data.url);
    }
  });
}
