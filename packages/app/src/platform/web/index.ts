import type { PlatformAdapters } from '../types.js';
import { WebStorage } from './storage.js';
import { WebSecureStore } from './secure-store.js';

export const webPlatform: PlatformAdapters = {
  name: 'web',
  storage: new WebStorage(),
  secureStore: new WebSecureStore(),
};
