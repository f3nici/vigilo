import {
  SYNC_PUSH_BATCH,
  backoffDelayMs,
  needsBootstrap,
  outboxDisposition,
  withJitter,
  type OutboxOperation,
  type SyncPushResult,
} from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import type { LocalStore } from '@/db/local';

/**
 * The sync engine (doc 05 §4 and §5).
 *
 * Pull is a cursor walk applied a page at a time; push is the outbox draining
 * in batches. Both are here rather than in a store, because both must be
 * callable from a background task, from a visibility change and from the
 * moment after a local write, and none of those has a component to hang off.
 *
 * Foreground sync is the primary path everywhere (doc 05 §8.2). iOS has no
 * background sync at all, so nothing here may assume it will ever be woken up:
 * every trigger is something the user or the network did.
 */

/** How many attachment uploads run per pass. Photos are large; entries are not. */
const ATTACHMENT_BATCH = 2;

/** Only one tab drains the outbox, whatever else is open. */
const PUSH_LOCK = 'vigilo.outbox-push';

export type SyncOutcome = {
  pulled: number;
  pushed: number;
  rejected: number;
  attachments: number;
  bootstrapped: boolean;
  /** Participants whose local data was dropped because access was revoked. */
  revoked: string[];
  error: string | null;
};

const nothing = (): SyncOutcome => ({
  pulled: 0,
  pushed: 0,
  rejected: 0,
  attachments: 0,
  bootstrapped: false,
  revoked: [],
  error: null,
});

export class SyncEngine {
  #running: Promise<SyncOutcome> | null = null;

  constructor(
    private readonly store: LocalStore,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * A full pass: push first, then pull.
   *
   * Push first on purpose. What the device holds and the server does not is
   * the only data in the system with one copy, so it goes first every single
   * time, including on the pass that runs immediately before a wipe.
   *
   * Concurrent calls share one pass rather than queueing. Being triggered by
   * a timer, a visibility change and a network event within the same second is
   * normal, and three passes at once would push the same batch three times.
   */
  sync(now = new Date()): Promise<SyncOutcome> {
    this.#running ??= this.#run(now).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run(now: Date): Promise<SyncOutcome> {
    const outcome = nothing();

    try {
      const pushed = await this.push(now);
      outcome.pushed = pushed.pushed;
      outcome.rejected = pushed.rejected;
      outcome.attachments = pushed.attachments;

      const pulled = await this.pull();
      outcome.pulled = pulled.pulled;
      outcome.bootstrapped = pulled.bootstrapped;
      outcome.revoked = pulled.revoked;
    } catch (error) {
      // Being offline is not a failure worth reporting as one (doc 06 §7).
      // Anything else is, because a worker needs to know their records are not
      // arriving.
      outcome.error = offline(error) ? null : describe(error);
    }

    return outcome;
  }

  /* ------------------------------------------------------------------ pull */

  async pull(): Promise<{ pulled: number; bootstrapped: boolean; revoked: string[] }> {
    const cursor = await this.store.cursor();

    if (cursor === 0) {
      return { ...(await this.bootstrap()), revoked: [] };
    }

    let applied = 0;
    const revoked: string[] = [];

    for (let page = 0; page < 50; page += 1) {
      const response = await api.syncChanges(await this.store.cursor());

      /*
       * The sequence went backwards, which only happens when the database was
       * restored from a backup. Walking on from a cursor the server has never
       * issued would silently skip everything written since the restore, so
       * the local copy is thrown away and rebuilt (doc 05 §10).
       */
      if (needsBootstrap(await this.store.cursor(), response.serverRevision)) {
        const result = await this.bootstrap();
        return { pulled: applied + result.pulled, bootstrapped: true, revoked };
      }

      const outcome = await this.store.applyPage({
        changes: response.changes,
        tombstones: response.tombstones,
        scopeChanges: response.scopeChanges,
        nextRevision: response.nextRevision,
        at: response.serverTime,
      });

      applied += response.changes.length;
      revoked.push(...outcome.revoked);

      /*
       * A grant means this device has never held that participant, and the
       * change list only carries what changed after the cursor. So a grant
       * asks for the snapshot again rather than hoping the rows turn up.
       */
      if (outcome.granted.length > 0) {
        const result = await this.bootstrap();
        return { pulled: applied + result.pulled, bootstrapped: true, revoked };
      }

      if (!response.hasMore) break;
    }

    return { pulled: applied, bootstrapped: false, revoked };
  }

  /**
   * The whole scoped snapshot.
   *
   * A new device, a reinstall, a grant, a restored database, or a local
   * database that turned up empty with a live session, which on iOS means the
   * browser evicted it (doc 05 §8.1).
   */
  async bootstrap(): Promise<{ pulled: number; bootstrapped: true }> {
    const snapshot = await api.syncBootstrap();

    await this.store.applyPage({
      changes: snapshot.changes,
      tombstones: [],
      scopeChanges: [],
      nextRevision: snapshot.revision,
      at: snapshot.serverTime,
    });

    return { pulled: snapshot.changes.length, bootstrapped: true };
  }

  /* ------------------------------------------------------------------ push */

  /**
   * Drains the outbox in `seq` order.
   *
   * Wrapped in a Web Lock because two tabs draining at once would send the
   * same batch twice. That is harmless on the server, which is idempotent by
   * op id, but it wastes a worker's mobile data and makes the queue depth on
   * screen jump about.
   */
  async push(now = new Date()): Promise<{ pushed: number; rejected: number; attachments: number }> {
    return withLock(PUSH_LOCK, async () => {
      let pushed = 0;
      let rejected = 0;

      for (let batch = 0; batch < 20; batch += 1) {
        const operations = await this.store.readyOperations(now, SYNC_PUSH_BATCH);
        if (operations.length === 0) break;

        let results: SyncPushResult[];
        try {
          results = (await api.syncPush(operations)).results;
        } catch (error) {
          await this.deferAll(operations, error, now);
          throw error;
        }

        const clear: string[] = [];
        for (const result of results) {
          if (outboxDisposition(result) === 'clear') {
            clear.push(result.opId);
            pushed += 1;
          } else if (result.status === 'rejected') {
            await this.store.flagOperation(result.opId, result.error.message);
            rejected += 1;
          }
        }
        await this.store.clearOperations(clear);

        if (operations.length < SYNC_PUSH_BATCH) break;
      }

      return { pushed, rejected, attachments: await this.pushAttachments(now) };
    });
  }

  /**
   * Photos, separately and afterwards.
   *
   * A 3 MB image must never hold up a 2 KB check entry, which is why this is
   * its own queue rather than more operations in the outbox (doc 05 §7). The
   * local copy is deleted only once the server says it has the file.
   */
  private async pushAttachments(now: Date): Promise<number> {
    let uploaded = 0;

    for (const queued of await this.store.readyAttachments(now, ATTACHMENT_BATCH)) {
      try {
        const attachment = await api.uploadAttachmentBytes(
          queued.attachmentId,
          queued.bytes,
          queued.mimeType,
        );
        if (attachment.uploadState === 'complete') {
          await this.store.clearAttachment(queued.attachmentId);
          uploaded += 1;
        }
      } catch (error) {
        if (permanent(error)) {
          // The server will never take it. Dropping the bytes is right: the
          // diary entry itself is already recorded and says the photo failed.
          await this.store.clearAttachment(queued.attachmentId);
        } else {
          await this.store.deferAttachment(
            queued.attachmentId,
            this.retryAt(1, now),
            describe(error),
          );
        }
      }
    }

    return uploaded;
  }

  private async deferAll(
    operations: readonly OutboxOperation[],
    error: unknown,
    now: Date,
  ): Promise<void> {
    for (const operation of operations) {
      await this.store.deferOperation(operation.opId, this.retryAt(1, now), describe(error));
    }
  }

  /** 5s, 15s, 1m, 5m, 15m, then hourly, jittered (doc 05 §5). */
  private retryAt(attempts: number, now: Date): Date {
    return new Date(now.getTime() + withJitter(backoffDelayMs(attempts), this.random));
  }
}

/* --------------------------------------------------------------- helpers */

function offline(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return error instanceof TypeError;
}

/** Nothing a retry can fix. */
function permanent(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    ['validation_failed', 'scope_denied', 'not_found', 'conflict'].includes(error.code)
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Runs work while holding a named lock, or straight away where the browser has
 * no Web Locks. The lock is an optimisation over an already-idempotent server,
 * so proceeding without one is safe.
 */
async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return work();
  return navigator.locks.request(name, work) as Promise<T>;
}
