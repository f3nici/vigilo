import type { PlatformAdapters } from '../types.js';
import { WebStorage } from './storage.js';
import { WebSecureStore } from './secure-store.js';
import { WebPush } from './push.js';

export const webPlatform: PlatformAdapters = {
  name: 'web',
  storage: new WebStorage(),
  secureStore: new WebSecureStore(),
  push: new WebPush(),
};
