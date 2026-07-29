import type { Config } from '../config.js';
import type { VapidKeys } from './push.js';

/**
 * The configured VAPID pair, or null.
 *
 * Both halves or neither. A public key with no private key would let the app
 * subscribe devices to a sender that can never send to them, which is worse
 * than not offering notifications at all.
 */
export function vapidKeys(config: Config): VapidKeys | null {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: config.VAPID_PUBLIC_KEY,
    privateKey: config.VAPID_PRIVATE_KEY,
    subject: config.VAPID_SUBJECT,
  };
}
