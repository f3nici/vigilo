import type { PlatformAdapters } from './types.js';
import { webPlatform } from './web/index.js';

export * from './types.js';

/**
 * The single entry point to platform capability. The native implementations
 * arrive in the final phases and are selected here, nowhere else.
 */
export function getPlatform(): PlatformAdapters {
  return webPlatform;
}

/**
 * Whether the app is running as an installed app rather than a browser tab.
 * The auth model follows from this: a tab gets the office session cookie, an
 * installed app gets the rotating refresh token (doc 02 §5).
 */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  // iOS Safari predates the display-mode media query for home-screen apps.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}
