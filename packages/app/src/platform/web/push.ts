import { PlatformNotImplementedError, type Push, type PushPermission } from '../types.js';

/**
 * PWA push: Web Push with VAPID through the service worker (Phase 5).
 *
 * On iOS this only works once the app is installed to the home screen, which
 * is why the install flow explains why installing matters.
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

  subscribe(): Promise<string> {
    return Promise.reject(new PlatformNotImplementedError('Web Push subscription', 'Phase 5'));
  }

  unsubscribe(): Promise<void> {
    return Promise.reject(new PlatformNotImplementedError('Web Push subscription', 'Phase 5'));
  }
}
