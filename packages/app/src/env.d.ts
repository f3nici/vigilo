/// <reference types="vite/client" />

/**
 * The app's version, replaced at build time from `package.json` (see
 * `vite.config.ts`). A constant rather than an import so the number lives in
 * exactly one place and nothing can ship a screen that disagrees with the
 * package that built it.
 */
declare const __APP_VERSION__: string;
