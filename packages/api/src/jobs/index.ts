import { schedule, type ScheduledTask } from 'node-cron';
import type { Database } from '../db/client.js';
import type { Logger } from '../logger.js';
import { jobRuns } from '../db/schema.js';
import { verifyAuditChain } from '../services/audit.js';
import { pruneExpiredAuth } from '../services/maintenance.js';

/**
 * Background jobs (doc 02 §6).
 *
 * All jobs are idempotent and safe to run twice, and each writes a job run
 * record with its outcome so a cron that stopped firing is visible rather than
 * silent. Phase 1 only has the two that identity needs; the window
 * materialiser and closer arrive in Phase 3.
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

export function startJobs(db: Database, logger: Logger): { stop: () => void } {
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

  logger.info({ jobs: tasks.length }, 'background jobs scheduled');

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
}
