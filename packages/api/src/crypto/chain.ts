import { createHash } from 'node:crypto';

/**
 * The audit hash chain (doc 03 §10, doc 07 §4).
 *
 * Each row hashes its canonical form plus the previous row's hash, so removing
 * or altering a row breaks the chain from that point on. A weekly job verifies
 * it and raises an alert on a break.
 */

export type AuditChainFields = {
  at: Date;
  actorUserId: string | null;
  actorIp: string | null;
  actorDeviceId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  participantId: string | null;
  metadata: Record<string, unknown>;
};

/** The first row's prev_hash. A fixed, recognisable anchor. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic serialisation. Object keys are sorted at every level, so two
 * runs over the same row always produce the same bytes regardless of how the
 * JSON came back from Postgres.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return `{${entries.join(',')}}`;
}

export function canonicalForm(fields: AuditChainFields): string {
  return canonicalJson({
    at: fields.at.toISOString(),
    actorUserId: fields.actorUserId,
    actorIp: fields.actorIp,
    actorDeviceId: fields.actorDeviceId,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId,
    participantId: fields.participantId,
    metadata: fields.metadata,
  });
}

export function chainHash(prevHash: string, fields: AuditChainFields): string {
  return createHash('sha256')
    .update(`${prevHash}\n${canonicalForm(fields)}`, 'utf8')
    .digest('hex');
}

export type ChainRow = AuditChainFields & {
  id: string | number;
  prevHash: string;
  hash: string;
};

export type ChainVerification =
  | { ok: true; rowsChecked: number }
  | {
      ok: false;
      rowsChecked: number;
      /** The first row that does not verify. Everything after it is suspect. */
      brokenAtId: string | number;
      reason: 'prev_hash_mismatch' | 'hash_mismatch';
    };

/**
 * Walks rows in id order and recomputes the chain. Rows must be passed in
 * ascending id order, which is the order they were written.
 */
export function verifyChain(
  rows: readonly ChainRow[],
  startingPrevHash = GENESIS_HASH,
): ChainVerification {
  let expectedPrev = startingPrevHash;
  let checked = 0;

  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { ok: false, rowsChecked: checked, brokenAtId: row.id, reason: 'prev_hash_mismatch' };
    }

    const recomputed = chainHash(row.prevHash, row);
    if (recomputed !== row.hash) {
      return { ok: false, rowsChecked: checked, brokenAtId: row.id, reason: 'hash_mismatch' };
    }

    expectedPrev = row.hash;
    checked += 1;
  }

  return { ok: true, rowsChecked: checked };
}
