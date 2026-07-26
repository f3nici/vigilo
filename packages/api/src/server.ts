import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const { db, sql } = createDatabase(config.DATABASE_URL);

  if (config.MIGRATE_ON_START) {
    logger.info('running migrations');
    await runMigrations(db);
    logger.info('migrations up to date');
  }

  const app = createApp(config, logger, db);
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, build: config.BUILD_HASH }, 'vigilo api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void sql.end().then(() => process.exit(0));
    });
    // Do not wait forever on a hung connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
