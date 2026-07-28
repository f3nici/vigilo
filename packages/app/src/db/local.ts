import type {
  SyncChange,
  SyncScopeChange,
  SyncTombstone,
  OutboxOperation,
  SyncStatus,
} from '@vigilo/shared';
import type { LocalDatabase, SecureStore, SqlStatement } from '@/platform';
import { dataTables, entityTables, migrations, participantScopedTables } from './schema';

/**
 * The local database, as the app uses it (doc 05 §8).
 *
 * Everything here is SQL against the `LocalDatabase` the platform adapter
 * hands over, so the same statements run against SQLite-WASM today and
 * Capacitor SQLite in the native phases. Nothing in this file knows which one
 * it is talking to.
 *
 * Every row is stored as its API DTO, sealed by the secure store, plus the
 * plain columns something needs to sort or filter on. Reading a row is
 * therefore an unseal, and reading a screen is one query plus a batch of
 * unseals rather than a join.
 */

const CURSOR_KEY = 'sync.cursor';
const LAST_SYNC_KEY = 'sync.last-at';
const OUTBOX_SEQ_KEY = 'outbox.seq';
const USER_KEY = 'session.user-id';

type MetaRow = { value: string };
type SealedRow = { sealed: string };

export class LocalStore {
  constructor(
    private readonly db: LocalDatabase,
    private readonly store: SecureStore,
  ) {}

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Brings the schema up to date.
   *
   * Migrations are applied in order and the version is recorded, so a device
   * that has skipped a release walks through both steps. It is never a wipe
   * and rebuild: a wipe takes the outbox with it, and the outbox is the one
   * thing on the device that exists nowhere else.
   */
  async migrate(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const current = Number((await this.meta('schema.version')) ?? '0');

    for (const migration of migrations) {
      if (migration.version <= current) continue;
      await this.db.transaction([
        ...migration.statements.map((sql) => ({ sql })),
        {
          sql: `INSERT INTO meta (key, value) VALUES ('schema.version', ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          params: [String(migration.version)],
        },
      ]);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Empties every table without dropping the database.
   *
   * Sign-out, a remote wipe, a suspended account, or thirty days with no
   * successful sync (doc 05 §8). The caller is responsible for flushing the
   * outbox first; this does not decide that for them.
   */
  async wipe(): Promise<void> {
    await this.db.transaction([
      ...dataTables.map((table) => ({ sql: `DELETE FROM ${table}` })),
      { sql: `DELETE FROM meta WHERE key <> 'schema.version'` },
    ]);
  }

  /* ----------------------------------------------------------------- meta */

  private async meta(key: string): Promise<string | null> {
    const rows = await this.db.all<MetaRow>('SELECT value FROM meta WHERE key = ?', [key]);
    return rows[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): SqlStatement {
    return {
      sql: `INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      params: [key, value],
    };
  }

  async cursor(): Promise<number> {
    return Number((await this.meta(CURSOR_KEY)) ?? '0');
  }

  async lastSyncAt(): Promise<string | null> {
    return this.meta(LAST_SYNC_KEY);
  }

  /**
   * Whose records these are.
   *
   * Checked at startup: a database belonging to a different user is not merged
   * with the new one, it is thrown away. Two workers sharing a phone must
   * never see each other's participants.
   */
  async userId(): Promise<string | null> {
    return this.meta(USER_KEY);
  }

  async claimFor(userId: string): Promise<void> {
    await this.db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [USER_KEY, userId],
    );
  }

  /** True when there is a session but no local data, which on iOS means eviction. */
  async isEmpty(): Promise<boolean> {
    const rows = await this.db.all<{ count: number }>('SELECT count(*) AS count FROM participants');
    return (rows[0]?.count ?? 0) === 0;
  }

  /* ---------------------------------------------------------- applying sync */

  /**
   * One page, one transaction (doc 05 §4).
   *
   * The order inside is deliberate. Revocations are applied first, so a page
   * that both revokes a participant and carries a row for them cannot leave
   * that row behind. Then tombstones, then upserts, then the cursor. The
   * cursor moving last is what makes an interrupted sync replay the page
   * rather than skip it.
   */
  async applyPage(input: {
    changes: readonly SyncChange[];
    tombstones: readonly SyncTombstone[];
    scopeChanges: readonly SyncScopeChange[];
    nextRevision: number;
    at: string;
  }): Promise<{ revoked: string[]; granted: string[] }> {
    const statements: SqlStatement[] = [];
    const revoked: string[] = [];
    const granted: string[] = [];

    for (const change of input.scopeChanges) {
      if (change.effect === 'revoked') {
        revoked.push(change.participantId);
        statements.push(...purgeStatements(change.participantId));
      } else {
        granted.push(change.participantId);
      }
    }

    for (const tombstone of input.tombstones) {
      const table = entityTables[tombstone.entity];
      if (!table) continue;
      statements.push({
        sql: `DELETE FROM ${table} WHERE ${table === 'emergency_plans' ? 'participant_id' : 'id'} = ?`,
        params: [tombstone.id],
      });
    }

    for (const change of input.changes) {
      // A row for a participant revoked in this same page is not written at
      // all, rather than written and deleted on the next one.
      if (change.participantId !== null && revoked.includes(change.participantId)) continue;
      const statement = await this.upsert(change);
      if (statement) statements.push(statement);
    }

    statements.push(this.setMeta(CURSOR_KEY, String(input.nextRevision)));
    statements.push(this.setMeta(LAST_SYNC_KEY, input.at));

    await this.db.transaction(statements);
    return { revoked, granted };
  }

  /** Everything about a participant, gone. A revocation, or an archive. */
  async purgeParticipant(participantId: string): Promise<void> {
    await this.db.transaction(purgeStatements(participantId));
  }

  private async upsert(change: SyncChange): Promise<SqlStatement | null> {
    const sealed = await this.store.seal(JSON.stringify(change.row));

    switch (change.entity) {
      case 'participant':
        return sqlUpsert(
          'participants',
          ['id', 'status', 'revision', 'sealed'],
          [change.id, change.row.status, change.revision, sealed],
        );

      case 'participant_alert':
        return sqlUpsert(
          'alerts',
          ['id', 'participant_id', 'severity', 'active', 'sort_order', 'revision', 'sealed'],
          [
            change.id,
            change.row.participantId,
            change.row.severity,
            change.row.active ? 1 : 0,
            change.row.sortOrder,
            change.revision,
            sealed,
          ],
        );

      case 'emergency_contact':
        return sqlUpsert(
          'contacts',
          ['id', 'participant_id', 'sort_order', 'revision', 'sealed'],
          [change.id, change.row.participantId, change.row.sortOrder ?? 0, change.revision, sealed],
        );

      case 'emergency_plan':
        return sqlUpsert(
          'emergency_plans',
          ['participant_id', 'revision', 'sealed'],
          [change.row.participantId, change.revision, sealed],
          'participant_id',
        );

      case 'check_template':
        return sqlUpsert(
          'templates',
          ['id', 'revision', 'sealed'],
          [change.id, change.revision, sealed],
        );

      case 'check_template_version':
        return sqlUpsert(
          'template_versions',
          ['id', 'revision', 'sealed'],
          [change.id, change.revision, sealed],
        );

      case 'check_schedule':
        return sqlUpsert(
          'schedules',
          ['id', 'participant_id', 'revision', 'sealed'],
          [change.id, change.row.participantId, change.revision, sealed],
        );

      case 'missed_reason_code':
        return sqlUpsert(
          'reason_codes',
          ['id', 'active', 'sort_order', 'revision', 'sealed'],
          [change.id, change.row.active ? 1 : 0, change.row.sortOrder, change.revision, sealed],
        );

      case 'diary_category':
        return sqlUpsert(
          'diary_categories',
          ['id', 'active', 'sort_order', 'revision', 'sealed'],
          [change.id, change.row.active ? 1 : 0, change.row.sortOrder, change.revision, sealed],
        );

      case 'check_window':
        return sqlUpsert(
          'windows',
          [
            'id',
            'participant_id',
            'starts_at',
            'ends_at',
            'status',
            'expected',
            'is_late',
            'entry_id',
            'template_version_id',
            'required_field_count',
            'filled_required_count',
            'revision',
            'sealed',
          ],
          [
            change.id,
            change.row.participantId,
            change.row.startsAt,
            change.row.endsAt,
            change.row.status,
            change.row.expected ? 1 : 0,
            change.row.isLate ? 1 : 0,
            change.row.entryId,
            change.row.templateVersionId,
            change.row.requiredFieldCount,
            change.row.filledRequiredCount,
            change.revision,
            sealed,
          ],
        );

      case 'check_entry':
        return sqlUpsert(
          'entries',
          ['id', 'window_id', 'participant_id', 'recorded_at', 'status', 'revision', 'sealed'],
          [
            change.id,
            change.row.windowId,
            change.row.participantId,
            change.row.recordedAt,
            change.row.status,
            change.revision,
            sealed,
          ],
        );

      case 'window_miss_reason':
        return sqlUpsert(
          'miss_reasons',
          ['id', 'window_id', 'revision', 'sealed'],
          [change.id, change.row.windowId, change.revision, sealed],
        );

      case 'diary_entry':
        return sqlUpsert(
          'diary_entries',
          [
            'id',
            'participant_id',
            'occurred_at',
            'category_id',
            'deleted_at',
            'revision',
            'sealed',
          ],
          [
            change.id,
            change.row.participantId,
            change.row.occurredAt,
            change.row.categoryId,
            change.row.deletedAt,
            change.revision,
            sealed,
          ],
        );

      case 'attachment':
        return sqlUpsert(
          'attachments',
          ['id', 'participant_id', 'owner_id', 'upload_state', 'revision', 'sealed'],
          [
            change.id,
            change.row.participantId,
            change.row.ownerId,
            change.row.uploadState,
            change.revision,
            sealed,
          ],
        );

      default:
        // An entity a later server release knows about and this build does
        // not. Skipped rather than crashing the sync: the row will be applied
        // once the app catches up, and everything else in the page still lands.
        return null;
    }
  }

  /* --------------------------------------------------------------- reading */

  private async unseal<T>(rows: readonly SealedRow[]): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(await this.store.unseal(row.sealed)) as T);
      } catch {
        // A row sealed under a key we no longer have. Skipping it is right:
        // the alternative is refusing to render the whole screen, and the next
        // bootstrap replaces it.
      }
    }
    return out;
  }

  async windowsBetween<T>(from: string, to: string): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(
        'SELECT sealed FROM windows WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at',
        [from, to],
      ),
    );
  }

  async participants<T>(): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(`SELECT sealed FROM participants WHERE status = 'active'`),
    );
  }

  async alertsFor<T>(participantId: string): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(
        'SELECT sealed FROM alerts WHERE participant_id = ? AND active = 1 ORDER BY sort_order',
        [participantId],
      ),
    );
  }

  async diaryFor<T>(participantId: string, limit = 100): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(
        `SELECT sealed FROM diary_entries
         WHERE participant_id = ? AND deleted_at IS NULL
         ORDER BY occurred_at DESC LIMIT ?`,
        [participantId, limit],
      ),
    );
  }

  async categories<T>(): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(
        'SELECT sealed FROM diary_categories WHERE active = 1 ORDER BY sort_order',
      ),
    );
  }

  async reasonCodes<T>(): Promise<T[]> {
    return this.unseal<T>(
      await this.db.all<SealedRow>(
        'SELECT sealed FROM reason_codes WHERE active = 1 ORDER BY sort_order',
      ),
    );
  }

  async templateVersion<T>(id: string): Promise<T | null> {
    const rows = await this.db.all<SealedRow>('SELECT sealed FROM template_versions WHERE id = ?', [
      id,
    ]);
    return (await this.unseal<T>(rows))[0] ?? null;
  }

  async window<T>(id: string): Promise<T | null> {
    const rows = await this.db.all<SealedRow>('SELECT sealed FROM windows WHERE id = ?', [id]);
    return (await this.unseal<T>(rows))[0] ?? null;
  }

  async entryForWindow<T>(windowId: string): Promise<T | null> {
    const rows = await this.db.all<SealedRow>('SELECT sealed FROM entries WHERE window_id = ?', [
      windowId,
    ]);
    return (await this.unseal<T>(rows))[0] ?? null;
  }

  /**
   * Writes a check the worker just recorded, before the server has seen it.
   *
   * Doc 05 §5: a local mutation writes the row and the outbox operation in one
   * transaction, so the screen updates instantly and the record is queued in
   * the same breath. The server's own version replaces this on the next pull,
   * which is what settles any disagreement about status or lateness.
   */
  async recordEntryLocally(input: {
    entry: { id: string; windowId: string; participantId: string; recordedAt: string };
    status: 'partial' | 'complete';
    filledRequiredCount: number;
    sealedEntry: unknown;
    windowStatus: string;
  }): Promise<void> {
    const sealed = await this.store.seal(JSON.stringify(input.sealedEntry));

    await this.db.transaction([
      sqlUpsert(
        'entries',
        ['id', 'window_id', 'participant_id', 'recorded_at', 'status', 'revision', 'sealed'],
        [
          input.entry.id,
          input.entry.windowId,
          input.entry.participantId,
          input.entry.recordedAt,
          input.status,
          0,
          sealed,
        ],
      ),
      {
        sql: `UPDATE windows
              SET status = ?, entry_id = ?, filled_required_count = ?
              WHERE id = ?`,
        params: [
          input.windowStatus,
          input.entry.id,
          input.filledRequiredCount,
          input.entry.windowId,
        ],
      },
    ]);
  }

  /* --------------------------------------------------------------- outbox */

  /**
   * Queues an operation.
   *
   * `op_id` is the primary key, so queueing the same operation twice is a
   * no-op rather than two records. `seq` orders the drain, which is what
   * guarantees a create reaches the server before the update to it.
   */
  async enqueue(operation: OutboxOperation, now = new Date()): Promise<void> {
    const seq = Number((await this.meta(OUTBOX_SEQ_KEY)) ?? '0') + 1;
    const entityId = entityIdOf(operation);

    await this.db.transaction([
      {
        sql: `INSERT INTO outbox
                (op_id, seq, kind, entity_id, participant_id, sealed_payload,
                 created_at, next_attempt_at, attempts, state)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')
              ON CONFLICT (op_id) DO NOTHING`,
        params: [
          operation.opId,
          seq,
          operation.kind,
          entityId,
          operation.participantId,
          await this.store.seal(JSON.stringify(operation)),
          now.toISOString(),
          now.toISOString(),
        ],
      },
      this.setMeta(OUTBOX_SEQ_KEY, String(seq)),
    ]);
  }

  /** What is due to be sent, oldest first, capped at one batch. */
  async readyOperations(now: Date, limit: number): Promise<OutboxOperation[]> {
    const rows = await this.db.all<{ sealed_payload: string }>(
      `SELECT sealed_payload FROM outbox
       WHERE state = 'pending' AND next_attempt_at <= ?
       ORDER BY seq LIMIT ?`,
      [now.toISOString(), limit],
    );

    const operations: OutboxOperation[] = [];
    for (const row of rows) {
      try {
        operations.push(JSON.parse(await this.store.unseal(row.sealed_payload)) as OutboxOperation);
      } catch {
        // Unreadable payload. Left in place rather than deleted: an operation
        // is a clinical record that has not reached the server, and quietly
        // dropping one is the failure this whole design exists to prevent.
      }
    }
    return operations;
  }

  async clearOperations(opIds: readonly string[]): Promise<void> {
    if (opIds.length === 0) return;
    await this.db.run(
      `DELETE FROM outbox WHERE op_id IN (${opIds.map(() => '?').join(',')})`,
      opIds,
    );
  }

  /** A transient failure: try again later, with the delay the caller worked out. */
  async deferOperation(opId: string, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db.run(
      `UPDATE outbox
       SET attempts = attempts + 1,
           first_attempt_at = COALESCE(first_attempt_at, ?),
           next_attempt_at = ?,
           last_error = ?
       WHERE op_id = ?`,
      [new Date().toISOString(), nextAttemptAt.toISOString(), error, opId],
    );
  }

  /** The server refused it. Retrying will not help, so a person is shown it. */
  async flagOperation(opId: string, error: string): Promise<void> {
    await this.db.run(
      `UPDATE outbox SET state = 'needs_user', last_error = ?, attempts = attempts + 1
       WHERE op_id = ?`,
      [error, opId],
    );
  }

  async outboxStatus(): Promise<Omit<SyncStatus, 'online' | 'lastSyncAt'>> {
    const rows = await this.db.all<{
      pending: number;
      needs_user: number;
      oldest: string | null;
    }>(`SELECT
          sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
          sum(CASE WHEN state = 'needs_user' THEN 1 ELSE 0 END) AS needs_user,
          min(CASE WHEN state = 'pending' THEN created_at END) AS oldest
        FROM outbox`);

    const row = rows[0];
    return {
      pendingCount: Number(row?.pending ?? 0),
      needsUserCount: Number(row?.needs_user ?? 0),
      oldestPendingAt: row?.oldest ?? null,
    };
  }

  async flaggedOperations(): Promise<
    { opId: string; kind: string; participantId: string; error: string; createdAt: string }[]
  > {
    return this.db.all(
      `SELECT op_id AS opId, kind, participant_id AS participantId,
              COALESCE(last_error, '') AS error, created_at AS createdAt
       FROM outbox WHERE state = 'needs_user' ORDER BY seq`,
    );
  }

  /* ----------------------------------------------------- attachment queue */

  async enqueueAttachment(input: {
    attachmentId: string;
    participantId: string;
    mimeType: string;
    bytes: Uint8Array;
    now?: Date;
  }): Promise<void> {
    const now = (input.now ?? new Date()).toISOString();
    await this.db.run(
      `INSERT INTO attachment_queue
         (attachment_id, participant_id, mime_type, byte_size, bytes, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (attachment_id) DO NOTHING`,
      [
        input.attachmentId,
        input.participantId,
        input.mimeType,
        input.bytes.byteLength,
        input.bytes,
        now,
        now,
      ],
    );
  }

  async readyAttachments(
    now: Date,
    limit: number,
  ): Promise<{ attachmentId: string; mimeType: string; bytes: Uint8Array }[]> {
    return this.db.all(
      `SELECT attachment_id AS attachmentId, mime_type AS mimeType, bytes
       FROM attachment_queue
       WHERE state = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at LIMIT ?`,
      [now.toISOString(), limit],
    );
  }

  /**
   * Only once the server has confirmed it holds the file. Deleting the local
   * copy on send would lose the photo if the response never arrived.
   */
  async clearAttachment(attachmentId: string): Promise<void> {
    await this.db.run('DELETE FROM attachment_queue WHERE attachment_id = ?', [attachmentId]);
  }

  async deferAttachment(attachmentId: string, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db.run(
      `UPDATE attachment_queue
       SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
       WHERE attachment_id = ?`,
      [nextAttemptAt.toISOString(), error, attachmentId],
    );
  }

  async pendingAttachmentCount(): Promise<number> {
    const rows = await this.db.all<{ count: number }>(
      `SELECT count(*) AS count FROM attachment_queue WHERE state = 'pending'`,
    );
    return Number(rows[0]?.count ?? 0);
  }
}

/** An upsert on `key`, since every synced row arrives as "this is the truth now". */
function sqlUpsert(
  table: string,
  columns: readonly string[],
  params: readonly unknown[],
  key = 'id',
): SqlStatement {
  const assignments = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
          ON CONFLICT (${key}) DO UPDATE SET ${assignments}`,
    params,
  };
}

/**
 * Everything belonging to one participant.
 *
 * Miss reasons hang off a window rather than a participant, so they go through
 * a subquery. Leaving them behind would keep a note about a person the device
 * is no longer allowed to hold, which is exactly what a revocation is for.
 */
function purgeStatements(participantId: string): SqlStatement[] {
  return [
    {
      sql: `DELETE FROM miss_reasons WHERE window_id IN
              (SELECT id FROM windows WHERE participant_id = ?)`,
      params: [participantId],
    },
    ...participantScopedTables.map((table) => ({
      sql: `DELETE FROM ${table} WHERE ${table === 'participants' ? 'id' : 'participant_id'} = ?`,
      params: [participantId],
    })),
    /*
     * The outbox is deliberately not purged here.
     *
     * Care that happened must reach the server whatever has changed about who
     * may read it afterwards (doc 05 §6). The queued records are pushed first
     * and the server decides; only then does the local copy go.
     */
  ];
}

function entityIdOf(operation: OutboxOperation): string {
  switch (operation.kind) {
    case 'check_entry.put':
      return operation.payload.entryId;
    case 'miss_reason.put':
      return operation.windowId;
    case 'diary_entry.create':
      return operation.payload.id;
    case 'diary_entry.update':
      return operation.entryId;
    case 'attachment.create':
      return operation.payload.id;
  }
}
