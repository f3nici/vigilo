import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { chainHash, GENESIS_HASH, verifyChain, type ChainRow } from '../crypto/chain.js';

/**
 * The audit log (doc 03 §10, doc 07 §4).
 *
 * Append-only and hash-chained. Views are recorded as well as writes, because
 * an access audit that only records changes cannot answer "who looked at this
 * person's record", which is the question that matters after a complaint.
 *
 * Metadata is redacted by contract: entity ids and action names, never clinical
 * values and never names. Callers pass ids, not content.
 */

export type AuditActor = {
  userId: string | null;
  ip: string | null;
  deviceId: string | null;
};

/** The break-glass CLI. Recorded with no user id and its own marker. */
export const CLI_ACTOR: AuditActor = { userId: null, ip: null, deviceId: null };

export type AuditEvent = {
  action: string;
  actor: AuditActor;
  entityType?: string | null;
  entityId?: string | null;
  participantId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends one row, chained to the previous one.
 *
 * The whole thing runs in a serialisable transaction with a lock, because two
 * concurrent writers reading the same tail hash would fork the chain and the
 * verification job would report a break that never happened.
 */
export async function recordAudit(db: Database, event: AuditEvent): Promise<void> {
  await db.transaction(async (tx) => {
    // One writer at a time for the tail of the chain. The lock key is an
    // arbitrary constant that only this code uses.
    await tx.execute(sql`select pg_advisory_xact_lock(4915623001)`);

    const [previous] = await tx.execute<{ hash: string }>(
      sql`select hash from audit_log order by id desc limit 1`,
    );
    const prevHash = previous?.hash ?? GENESIS_HASH;

    const at = new Date();
    const fields = {
      at,
      actorUserId: event.actor.userId,
      actorIp: event.actor.ip,
      actorDeviceId: event.actor.deviceId,
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      participantId: event.participantId ?? null,
      metadata: event.metadata ?? {},
    };

    await tx.insert(auditLog).values({
      ...fields,
      prevHash,
      hash: chainHash(prevHash, fields),
    });
  });
}

/** Batched to one row per user per participant per 15 minutes (doc 07 §4). */
const VIEW_BATCH_MINUTES = 15;

export async function recordParticipantView(
  db: Database,
  actor: AuditActor,
  participantId: string,
): Promise<void> {
  if (actor.userId === null) return;

  const windowStart = new Date(
    Math.floor(Date.now() / (VIEW_BATCH_MINUTES * 60_000)) * (VIEW_BATCH_MINUTES * 60_000),
  );

  // Claim the batch first. If another request in the same window already has
  // it, there is nothing to log.
  const claimed = await db.execute<{ user_id: string }>(sql`
    insert into audit_view_batches (user_id, participant_id, window_start)
    values (${actor.userId}::uuid, ${participantId}::uuid, ${windowStart.toISOString()}::timestamptz)
    on conflict do nothing
    returning user_id
  `);

  if (claimed.length === 0) return;

  await recordAudit(db, {
    action: 'participant.view',
    actor,
    entityType: 'participant',
    entityId: participantId,
    participantId,
    metadata: { batchedMinutes: VIEW_BATCH_MINUTES },
  });
}

export type ChainCheck = ReturnType<typeof verifyChain>;

/** Walks the whole chain in id order. Used by the weekly job and by the CLI. */
export async function verifyAuditChain(db: Database, batchSize = 5000): Promise<ChainCheck> {
  let lastId = 0;
  let expectedPrev = GENESIS_HASH;
  let checked = 0;

  for (;;) {
    const rows = await db.execute<{
      id: string;
      at: Date;
      actor_user_id: string | null;
      actor_ip: string | null;
      actor_device_id: string | null;
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      participant_id: string | null;
      metadata: Record<string, unknown>;
      prev_hash: string;
      hash: string;
    }>(sql`
      select id, at, actor_user_id, actor_ip, actor_device_id, action,
             entity_type, entity_id, participant_id, metadata, prev_hash, hash
      from audit_log
      where id > ${lastId}
      order by id
      limit ${batchSize}
    `);

    if (rows.length === 0) break;

    const chainRows: ChainRow[] = rows.map((row) => ({
      id: Number(row.id),
      at: new Date(row.at),
      actorUserId: row.actor_user_id,
      actorIp: row.actor_ip,
      actorDeviceId: row.actor_device_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      participantId: row.participant_id,
      metadata: row.metadata,
      prevHash: row.prev_hash,
      hash: row.hash,
    }));

    const result = verifyChain(chainRows, expectedPrev);
    if (!result.ok) {
      return { ...result, rowsChecked: checked + result.rowsChecked };
    }

    checked += result.rowsChecked;
    expectedPrev = chainRows[chainRows.length - 1]!.hash;
    lastId = Number(rows[rows.length - 1]!.id);
  }

  return { ok: true, rowsChecked: checked };
}
