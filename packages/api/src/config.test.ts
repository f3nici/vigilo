import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost:5432/vigilo',
  MASTER_KEY: randomBytes(32).toString('base64'),
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('fails without a database url', () => {
    expect(() => loadConfig({ MASTER_KEY: base.MASTER_KEY } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('fails without a master key, rather than starting unable to decrypt', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /MASTER_KEY/,
    );
  });

  it('defaults the Capacitor origin so native sign-in works later', () => {
    const config = loadConfig(base);
    expect(config.CORS_ORIGINS).toContain('https://localhost');
  });

  it('splits a configured origin list', () => {
    const config = loadConfig({
      ...base,
      CORS_ORIGINS: 'https://vigilo.example, https://localhost',
    } as NodeJS.ProcessEnv);
    expect(config.CORS_ORIGINS).toEqual(['https://vigilo.example', 'https://localhost']);
  });

  it('rejects an unknown samesite value', () => {
    expect(() =>
      loadConfig({ ...base, SESSION_SAMESITE: 'sometimes' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('falls back to the serving connection for migrations when none is given', () => {
    const config = loadConfig(base);
    expect(config.migrateDatabaseUrl).toBe(base.DATABASE_URL);
  });

  it('keeps the owner connection separate when one is configured', () => {
    const config = loadConfig({
      ...base,
      MIGRATE_DATABASE_URL: 'postgres://owner@localhost:5432/vigilo',
    } as NodeJS.ProcessEnv);
    expect(config.migrateDatabaseUrl).toBe('postgres://owner@localhost:5432/vigilo');
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
  });
});

describe('optional settings', () => {
  const required = {
    DATABASE_URL: 'postgres://vigilo:vigilo@localhost:5432/vigilo',
    MASTER_KEY: 'a'.repeat(44),
  } as NodeJS.ProcessEnv;

  it('treats a blank optional setting as absent', () => {
    /*
     * `docker compose` turns `${VAPID_PUBLIC_KEY:-}` into an empty string, not
     * into nothing. Leaving the keys blank the way .env.example documents used
     * to stop the API starting at all.
     */
    const config = loadConfig({
      ...required,
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
      MIGRATE_DATABASE_URL: '',
      APP_DB_PASSWORD: '',
    });

    expect(config.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(config.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(config.VAPID_SUBJECT).toBe('mailto:admin@example.com');
    // The migrate URL falls back to the serving one, as it does when unset.
    expect(config.migrateDatabaseUrl).toBe(required.DATABASE_URL);
  });

  it('still takes a real value', () => {
    const config = loadConfig({ ...required, VAPID_PUBLIC_KEY: 'a-public-key' });
    expect(config.VAPID_PUBLIC_KEY).toBe('a-public-key');
  });
});
