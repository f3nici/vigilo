import { describe, expect, it } from 'vitest';
import { isReady, readyResponseSchema } from './health.js';

describe('isReady', () => {
  it('is ready only when the database and migrations are both good', () => {
    expect(isReady({ database: true, migrations: true })).toBe(true);
    expect(isReady({ database: true, migrations: false })).toBe(false);
    expect(isReady({ database: false, migrations: true })).toBe(false);
    expect(isReady({ database: false, migrations: false })).toBe(false);
  });
});

describe('readyResponseSchema', () => {
  it('accepts a well formed response', () => {
    const parsed = readyResponseSchema.parse({
      status: 'ready',
      build: 'abc1234',
      checks: { database: true, migrations: true },
    });
    expect(parsed.status).toBe('ready');
  });

  it('rejects an unknown status', () => {
    expect(() =>
      readyResponseSchema.parse({
        status: 'maybe',
        build: 'abc1234',
        checks: { database: true, migrations: true },
      }),
    ).toThrow();
  });
});
