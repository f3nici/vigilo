import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The integration suites share one database and truncate between tests, so
    // they run one file at a time. Parallelism here buys nothing and produces
    // failures that are about the harness rather than the code.
    fileParallelism: false,
  },
});
