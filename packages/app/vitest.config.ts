import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  plugins: [vue()],
  // Same define as the build, so a component that shows the version can be
  // mounted in a test without it being undefined.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
