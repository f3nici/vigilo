import type { SyncEntity } from '@vigilo/shared';
import type { Database } from '../db/client.js';
import { syncDeletions } from '../db/schema.js';

/**
 * Tombstones (doc 03 §11, doc 05 §4).
 *
 * A device walking a revision cursor sees rows that changed. It cannot see a
 * row that is no longer there, because an absent row and an unchanged row look
 * identical. So a deletion is recorded as its own row and travels on the same
 * cursor as everything else.
 *
 * This lives on its own rather than in sync.ts so the services that delete
 * things can call it without importing the sync layer, which imports them.
 */
export async function recordDeletion(
  db: Database,
  entity: SyncEntity,
  entityId: string,
  participantId: string | null,
): Promise<void> {
  await db.insert(syncDeletions).values({ entityType: entity, entityId, participantId });
}

export async function recordDeletions(
  db: Database,
  entity: SyncEntity,
  rows: readonly { id: string; participantId: string | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(syncDeletions).values(
    rows.map((row) => ({
      entityType: entity,
      entityId: row.id,
      participantId: row.participantId,
    })),
  );
}
