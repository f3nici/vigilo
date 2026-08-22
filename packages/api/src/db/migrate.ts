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

/**
 * Gives the application role a login and password, as the owner.
 *
 * The role itself is created by migration 0003 with its grants, including the
 * revoked UPDATE and DELETE on the audit log. This only makes it usable. It is
 * a no-op when no separate app role is configured, which is the local default.
 */
export async function provisionAppRole(
  ownerDb: Database,
  role: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`Refusing to provision an unusual role name: ${role}`);
  }
  // A role name cannot be a bind parameter in ALTER ROLE, so the statement is
  // built by Postgres itself with %I and %L quoting rather than by string
  // concatenation here.
  const [row] = await ownerDb.execute<{ statement: string }>(
    sql`select format('ALTER ROLE %I LOGIN PASSWORD %L', ${role}::text, ${password}::text) as statement`,
  );
  if (!row?.statement) throw new Error('Could not build the role provisioning statement');

  // ALTER ROLE touches a shared catalogue row, so two API replicas starting at
  // the same moment fail with "tuple concurrently updated". An advisory lock
  // makes startup order irrelevant.
  await ownerDb.execute(sql`select pg_advisory_lock(4915623002)`);
  try {
    await ownerDb.execute(sql.raw(row.statement));
  } finally {
    await ownerDb.execute(sql`select pg_advisory_unlock(4915623002)`);
  }
}

/** `npm run migrate`, and what the API calls before it starts serving. */
export async function migrateWithOwner(config: ReturnType<typeof loadConfig>): Promise<void> {
  const logger = createLogger({ level: config.LOG_LEVEL, format: config.LOG_FORMAT });
  const { db, sql: client } = createDatabase(config.migrateDatabaseUrl);

  try {
    logger.info({ migrationsFolder }, 'running migrations');
    await runMigrations(db);

    if (config.APP_DB_PASSWORD) {
      await provisionAppRole(db, config.APP_DB_ROLE, config.APP_DB_PASSWORD);
      logger.info({ role: config.APP_DB_ROLE }, 'application database role provisioned');
    }

    logger.info('migrations up to date');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await migrateWithOwner(loadConfig());
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
