import { schedule, type ScheduledTask } from 'node-cron';
import type { Database } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { KeyRing } from '../crypto/keys.js';
import { eq } from 'drizzle-orm';
import { exportJobs, jobRuns } from '../db/schema.js';
import { verifyAuditChain } from '../services/audit.js';
import { pruneExpiredAuth } from '../services/maintenance.js';
import { closeWindows, materialiseHorizon } from '../services/windows.js';
import { closeDoses, materialiseDoseHorizon } from '../services/doses.js';
import { claimQueuedExports, pruneExports, runExport } from '../services/exports.js';
import { resolveScopeFor } from '../services/scope.js';
import { findById } from '../services/auth.js';
import type { FileStore } from '../services/storage.js';

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
  store: FileStore,
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
   * The dose materialiser (doc 01 §7.2). Same hourly beat and the same
   * seven-day horizon as the check grid, for the same reason: a phone that
   * loses signal on Monday still has to know what is due on Thursday.
   */
  tasks.push(
    schedule('10 * * * *', () => {
      void runJob(db, logger, 'medications.materialise_doses', async () => {
        return { status: 'ok', detail: { ...(await materialiseDoseHorizon(db)) } };
      });
    }),
  );

  /**
   * The dose closer. A dose past its grace period with nobody signing it off
   * is a missed dose, which is what puts it at the top of the next worker's
   * Today screen.
   */
  tasks.push(
    schedule('*/5 * * * *', () => {
      void runJob(db, logger, 'medications.close_doses', async () => {
        return { status: 'ok', detail: { ...(await closeDoses(db)) } };
      });
    }),
  );

  /**
   * Queued CSV exports (doc 01 §8.4).
   *
   * Every minute, a few at a time. An export past the row threshold is minutes
   * of work, and running them one after another keeps a large one from
   * starving the API of connections while somebody is trying to record a check.
   */
  tasks.push(
    schedule('* * * * *', () => {
      void runJob(db, logger, 'exports.build', async () => {
        const queued = await claimQueuedExports(db);
        let built = 0;

        for (const row of queued) {
          const user = await findById(db, row.userId);
          if (!user || user.status !== 'active') {
            // The account is gone or suspended. The export goes with it rather
            // than being built for somebody who can no longer sign in.
            await db.delete(exportJobs).where(eq(exportJobs.id, row.id));
            continue;
          }

          /*
           * Scope resolved now, not when the export was requested. Somebody
           * who lost a participant between asking and the job running must not
           * get a file built with the access they used to have.
           */
          const scope = await resolveScopeFor(db, {
            userId: user.id,
            role: user.role,
            participantId: user.participantId,
          });

          await runExport(db, keyRing, store, row, scope);
          built += 1;
        }

        return { status: 'ok', detail: { built } };
      });
    }),
  );

  /** Built exports are decrypted participant data on a volume, so they go. */
  tasks.push(
    schedule('15 * * * *', () => {
      void runJob(db, logger, 'exports.prune', async () => {
        return { status: 'ok', detail: { removed: await pruneExports(db, store) } };
      });
    }),
  );

  logger.info({ jobs: tasks.length }, 'background jobs scheduled');

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
}
