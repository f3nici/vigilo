import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { KeyRing } from '../src/crypto/keys.js';
import { MASTER_KEY } from './helpers.js';

/**
 * Integration test against a real Postgres. CI provides one as a service
 * container, locally `docker compose up db` does the same.
 */
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://vigilo:vigilo@localhost:5432/vigilo_test';

let app: Express;
let close: () => Promise<void>;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    MASTER_KEY,
    LOG_LEVEL: 'silent',
    BUILD_HASH: 'test-build',
    MIGRATE_ON_START: 'false',
  } as NodeJS.ProcessEnv);

  const logger = createLogger('silent');
  const { db, sql } = createDatabase(databaseUrl);
  await runMigrations(db);

  app = createApp(config, logger, db, KeyRing.fromEnv(MASTER_KEY));
  close = async () => {
    await sql.end();
  };
});

afterAll(async () => {
  await close?.();
});

describe('GET /api/health', () => {
  it('reports ok with the build hash', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', build: 'test-build' });
  });

  it('sends X-Server-Time so devices can measure skew', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-server-time']).toBeDefined();
    expect(Number.isNaN(Date.parse(res.headers['x-server-time'] as string))).toBe(false);
  });

  it('sends a request id', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('GET /api/ready', () => {
  it('is ready once migrations have run', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks).toEqual({ database: true, migrations: true });
  });
});

describe('unknown routes', () => {
  it('return the not_found error envelope', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(typeof res.body.error.message).toBe('string');
  });
});

describe('CORS', () => {
  it('allows the Capacitor origin so native sign-in does not fail silently', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://localhost');
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an unknown origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
