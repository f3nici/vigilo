import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Times are ISO 8601 with offset everywhere. Keep the driver out of the
    // business of reinterpreting them.
    types: {},
    // The driver prints Postgres NOTICEs to stdout by default, which breaks
    // the structured JSON log stream. Migrations are the noisy ones.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });
  return { db, sql };
}

export { schema };
