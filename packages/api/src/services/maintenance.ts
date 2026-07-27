import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

/**
 * Removes auth rows that can no longer authenticate anything.
 *
 * Nothing here is a clinical record, so this genuinely deletes rather than
 * archives. The "nothing is ever hard-deleted" rule is about the record, not
 * about expired session rows.
 *
 * Revoked and expired rows are kept for a grace period so that a refresh-token
 * reuse attempt still finds the row it needs to detect theft.
 */
const GRACE_DAYS = 30;

export type PruneResult = {
  sessions: number;
  refreshTokens: number;
  challenges: number;
  viewBatches: number;
};

export async function pruneExpiredAuth(db: Database): Promise<PruneResult> {
  const cutoff = sql`now() - make_interval(days => ${GRACE_DAYS})`;

  const sessions = await db.execute(
    sql`delete from sessions where expires_at < ${cutoff} returning id`,
  );
  const refreshTokens = await db.execute(
    sql`delete from refresh_tokens where expires_at < ${cutoff} returning id`,
  );
  const challenges = await db.execute(
    sql`delete from auth_challenges where expires_at < now() - make_interval(days => 1) returning id`,
  );
  // Only the dedupe marker goes; the audit rows it produced stay forever.
  const viewBatches = await db.execute(
    sql`delete from audit_view_batches where window_start < ${cutoff} returning user_id`,
  );

  return {
    sessions: sessions.length,
    refreshTokens: refreshTokens.length,
    challenges: challenges.length,
    viewBatches: viewBatches.length,
  };
}
