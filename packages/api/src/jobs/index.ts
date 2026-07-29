import { schedule, type ScheduledTask } from 'node-cron';
import type { Database } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { KeyRing } from '../crypto/keys.js';
import { jobRuns } from '../db/schema.js';
import { verifyAuditChain } from '../services/audit.js';
import { pruneExpiredAuth } from '../services/maintenance.js';
import { closeWindows, materialiseHorizon } from '../services/windows.js';
import { runNotifications, pruneNotificationHistory } from '../services/notifications.js';
import type { VapidKeys } from '../services/push.js';

/**
 * Background jobs (doc 02 §6).
 *
 * All jobs are idempotent and safe to run twice, and each writes a job run
 * record with its outcome so a cron that stopped firing is visible rather than
 * silent.
 */

type JobResult = { status: 'ok' | 'failed'; detail: Record<string, unknown> };

async function runJob(
  db: Database,
  logger: Logger,
  jobName: string,
  work: () => Promise<JobResult>,
): Promise<void> {
  const startedAt = new Date();
  let result: JobResult;

  try {
    result = await work();
  } catch (error) {
    logger.error({ err: error, jobName }, 'job failed');
    result = { status: 'failed', detail: { error: String(error) } };
  }

  await db.insert(jobRuns).values({
    jobName,
    startedAt,
    finishedAt: new Date(),
    status: result.status,
    detail: result.detail,
  });
}

export function startJobs(
  db: Database,
  logger: Logger,
  keyRing: KeyRing,
  vapid: VapidKeys | null,
): { stop: () => void } {
  const tasks: ScheduledTask[] = [];

  /**
   * Weekly chain verification (doc 07 §4). A break means a row was altered or
   * removed, which is a possible tampering incident, so it is logged loudly
   * rather than counted.
   */
  tasks.push(
    schedule('0 3 * * 1', () => {
      void runJob(db, logger, 'audit.verify_chain', async () => {
        const result = await verifyAuditChain(db);
        if (result.ok) {
          logger.info({ rowsChecked: result.rowsChecked }, 'audit chain verified');
          return { status: 'ok', detail: { rowsChecked: result.rowsChecked } };
        }

        logger.error(
          { brokenAtId: result.brokenAtId, reason: result.reason },
          'AUDIT CHAIN BROKEN, treat as a possible tampering incident',
        );
        return {
          status: 'failed',
          detail: {
            rowsChecked: result.rowsChecked,
            brokenAtId: result.brokenAtId,
            reason: result.reason,
          },
        };
      });
    }),
  );

  /** Daily tidy-up of expired sessions, challenges and refresh tokens. */
  tasks.push(
    schedule('30 3 * * *', () => {
      void runJob(db, logger, 'auth.prune_expired', async () => {
        const removed = await pruneExpiredAuth(db);
        return { status: 'ok', detail: removed };
      });
    }),
  );

  /**
   * The window materialiser (doc 01 §5.3). Lays the grid 7 days ahead so a
   * phone that loses signal on Monday still knows what is due on Thursday.
   *
   * Hourly rather than nightly because a schedule created at 10am should not
   * wait until tomorrow to produce windows, and because an hourly idempotent
   * insert costs nothing when there is nothing to add.
   */
  tasks.push(
    schedule('5 * * * *', () => {
      void runJob(db, logger, 'checks.materialise_windows', async () => {
        const result = await materialiseHorizon(db);
        if (result.skippedUnpublished > 0) {
          logger.warn(
            { skipped: result.skippedUnpublished },
            'schedules point at a check form with no published version, so no windows were made for them',
          );
        }
        return { status: 'ok', detail: { ...result } };
      });
    }),
  );

  /**
   * The closer. Moves windows that have closed unrecorded to `missed`, which
   * is what puts them at the top of the next worker's Today screen.
   *
   * Every five minutes: a worker who misses a check should see it prompted
   * within the same shift, not the next day.
   */
  tasks.push(
    schedule('*/5 * * * *', () => {
      void runJob(db, logger, 'checks.close_windows', async () => {
        const result = await closeWindows(db);
        return { status: 'ok', detail: { ...result } };
      });
    }),
  );

  /**
   * Notifications (doc 09 Phase 5). Same five minutes as the closer, and
   * immediately after it in the hour, so a window that has just been marked
   * missed is notified about in the same tick rather than five minutes later.
   *
   * Every send is deduplicated by (user, kind, window), so running this often
   * does not mean notifying often. It means noticing quickly.
   */
  tasks.push(
    schedule('*/5 * * * *', () => {
      void runJob(db, logger, 'push.notify', async () => {
        const result = await runNotifications(db, keyRing, vapid);
        return { status: 'ok', detail: { ...result } };
      });
    }),
  );

  /** Clears the dedupe table so it does not grow without bound. */
  tasks.push(
    schedule('45 3 * * *', () => {
      void runJob(db, logger, 'push.prune_history', async () => {
        return { status: 'ok', detail: { removed: await pruneNotificationHistory(db) } };
      });
    }),
  );

  if (vapid === null) {
    logger.info('no VAPID keys configured, so push notifications are off');
  }

  logger.info({ jobs: tasks.length }, 'background jobs scheduled');

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
}
