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

/**
 * Whether biometric unlock is worth offering here at all (#24).
 *
 * Three things have to be true. The device needs a platform authenticator, or
 * the prompt is a dead end. It has to be an installed app, because a
 * fingerprint that unlocks a browser tab somebody opened once is a credential
 * sitting in a tab nobody will close. And it has to be a handheld: a desktop
 * with a fingerprint reader is a shared machine in an office more often than it
 * is somebody's own, and "sign in with your finger" on a machine four people
 * use is the wrong offer even when it works.
 *
 * A PIN is offered wherever biometrics are not, which is what stops this being
 * a way of locking anybody out.
 */
export async function canOfferBiometric(): Promise<boolean> {
  if (!isInstalled() || !isHandheld()) return false;
  return (await getPlatform().passkeys.availability()).platformAuthenticator;
}

/**
 * A phone or a tablet rather than a desktop.
 *
 * A coarse pointer with touch. Not perfect, and it does not have to be: the
 * cost of getting it wrong either way is an offer that is shown or withheld,
 * never a person who cannot get in.
 */
export function isHandheld(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && navigator.maxTouchPoints > 0;
}
