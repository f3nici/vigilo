import type { Push, PushPermission, PushSubscriptionKeys } from '../types.js';

/**
 * PWA push: Web Push with VAPID through the service worker (doc 04 §14).
 *
 * On iOS none of this works until the app is on the home screen, which is the
 * concrete reason the install flow exists rather than being a nag. Safari
 * gives an installed PWA push and a browser tab nothing at all.
 */
export class WebPush implements Push {
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  permission(): PushPermission {
    if (!this.isSupported()) return 'unsupported';
    switch (Notification.permission) {
      case 'granted':
        return 'granted';
      case 'denied':
        return 'denied';
      default:
        return 'prompt';
    }
  }

  async requestPermission(): Promise<PushPermission> {
    if (!this.isSupported()) return 'unsupported';
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'prompt';
  }

  /**
   * Subscribes and hands back what the API stores.
   *
   * Returns null rather than throwing when there is nothing to do. An
   * unsupported browser, a refused permission and a deployment with no VAPID
   * key are all ordinary states, and none of them should stop a worker
   * recording a check.
   */
  async subscribe(applicationServerKey: string): Promise<PushSubscriptionKeys | null> {
    if (!this.isSupported()) return null;
    if (this.permission() !== 'granted') return null;

    const registration = await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        // Required everywhere now, and by iOS absolutely: a subscription that
        // could send a silent push is refused outright.
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(applicationServerKey) as BufferSource,
      }));

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;

    return {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      expirationTime: subscription.expirationTime ?? null,
    };
  }

  async unsubscribe(): Promise<void> {
    if (!this.isSupported()) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
}

/** VAPID keys travel as base64url; `applicationServerKey` wants raw bytes. */
function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
