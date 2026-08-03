import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { createRequire } from 'node:module';

/*
 * The version the System screen shows, read from this package rather than typed
 * in a second place. One number, bumped once, and the screen cannot disagree
 * with the package that built it.
 */
const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      /*
       * Our own service worker rather than a generated one. It has to handle
       * push, notification clicks and a deferred update, none of which
       * generateSW can express.
       */
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null,

      injectManifest: {
        /*
         * `wasm` matters as much as `js` here. The SQLite binary is fetched by
         * the database worker at runtime, so leaving it out precaches an app
         * that opens offline and then cannot read a single record.
         */
        globPatterns: ['**/*.{js,css,html,woff2,svg,wasm}', 'icons/*.png'],
        /*
         * Startup images are excluded on purpose. There are thirty of them and
         * a phone needs exactly one; precaching the set would download 360 KB
         * of screens for devices the user does not own, on the mobile data of
         * somebody standing in a hallway. They are cached at runtime instead.
         */
        globIgnores: ['**/node_modules/**', 'splash/**'],
        /* The SQLite WASM binary is about 1 MB and has to be there offline. */
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },

      devOptions: {
        /*
         * On in development so the install path, the update prompt and offline
         * behaviour are exercised while building them rather than discovered
         * after a deploy.
         */
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
      },

      manifest: {
        name: 'Vigilo',
        short_name: 'Vigilo',
        description: 'Care records for a disability support team.',
        /*
         * Not "/" : an installed app that opens on the sign-in screen and then
         * redirects is a wasted second and a visible flash. Today is where a
         * worker is going.
         */
        // The root, not /today: it redirects to whichever home the signed-in
        // role belongs on (D90), so a worker's installed app opens on their
        // participants rather than on a screen they cannot reach.
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#141311',
        theme_color: '#0F6E6E',
        lang: 'en-AU',
        dir: 'ltr',
        categories: ['medical', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Android crops these to the launcher's shape, so they are drawn
          // with the mark inside the safe zone.
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          // Android 13 themed icons.
          {
            src: '/icons/monochrome-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'monochrome',
          },
        ],
        shortcuts: [
          {
            name: "Today's checks",
            url: '/today',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Participants',
            url: '/participants',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  /*
   * No COOP/COEP headers, deliberately.
   *
   * SQLite-WASM has two OPFS backends. The original one needs SharedArrayBuffer
   * and therefore cross-origin isolation, which would mean every cross-origin
   * subresource needing CORP headers for the rest of the product's life. The
   * `opfs-sahpool` backend needs only synchronous access handles, which Safari
   * and Chrome both give a dedicated worker. We use that one, and the cost is
   * that one tab owns the database at a time. See db/worker.ts.
   */
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  optimizeDeps: {
    // Ships its own worker and wants to be loaded as-is.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    // Hashed assets get an immutable cache at the nginx layer, index.html does
    // not. The Partforge stale-bundle problem, worse once a service worker
    // lands in Phase 5.
    assetsDir: 'assets',
    sourcemap: true,
  },
});
