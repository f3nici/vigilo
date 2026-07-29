import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/client.js';
import { migrateWithOwner } from './db/migrate.js';
import { KeyRing } from './crypto/keys.js';
import { startJobs } from './jobs/index.js';
import { createFileStore } from './services/storage.js';
import { vapidKeys } from './services/vapid.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // Fail before listening if the master key is wrong, rather than on the first
  // request that needs to decrypt something.
  const keyRing = KeyRing.fromEnv(config.MASTER_KEY);

  // Migrations run as the owner; serving happens as the restricted app role.
  if (config.MIGRATE_ON_START) {
    await migrateWithOwner(config);
  }

  // Fail here rather than on the first photo somebody tries to attach.
  const store = createFileStore(config.ATTACHMENT_DIR);
  await store.ensureWritable();

  const { db, sql } = createDatabase(config.DATABASE_URL);

  const app = createApp(config, logger, db, keyRing);
  const jobs = startJobs(db, logger, keyRing, vapidKeys(config), store);

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, build: config.BUILD_HASH }, 'vigilo api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    jobs.stop();
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
