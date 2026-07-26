import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://localhost:5432/vigilo' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('fails without a database url', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
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
});
