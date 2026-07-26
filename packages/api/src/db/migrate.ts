import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { createDatabase } from './client.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The generated SQL lives in packages/api/drizzle. From src/db that is two
 * levels up, and from dist/db it is the same, because the folder is copied
 * next to dist in the image.
 */
export const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}

type Journal = { entries: { idx: number; tag: string }[] };

async function journalEntryCount(): Promise<number> {
  const raw = await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
  const journal = JSON.parse(raw) as Journal;
  return journal.entries.length;
}

/**
 * True when the code carries migrations the database has not applied. This is
 * what makes /api/ready meaningful: a container mid-rollout is live but not
 * ready, and the break-glass CLI refuses to run at all (doc 02 §9).
 */
export async function migrationsPending(db: Database): Promise<boolean> {
  const expected = await journalEntryCount();

  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  const applied = Number(result[0]?.count ?? 0);

  return applied < expected;
}

/** `npm run migrate`, and the entrypoint the container calls before serving. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const { db, sql: client } = createDatabase(config.DATABASE_URL);

  try {
    logger.info({ migrationsFolder }, 'running migrations');
    await runMigrations(db);
    logger.info('migrations up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
