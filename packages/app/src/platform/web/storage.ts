import {
  type LocalDatabase,
  type OpenResult,
  type SqlStatement,
  type Storage,
  type StorageEstimate,
} from '../types.js';

/**
 * PWA storage: SQLite-WASM over OPFS in a worker thread (doc 05 §8).
 *
 * Two responsibilities beyond talking to the worker. It asks for persistent
 * storage, because iOS evicts OPFS after about seven days unused and that
 * takes an unsent outbox with it (doc 05 §8.1). And it makes sure exactly one
 * tab owns the database, because the sahpool VFS does not share.
 */

/** Held for as long as this tab owns the database. */
const DB_LOCK = 'vigilo.local-database';

type WorkerResponse =
  { id: number; ok: true; rows?: unknown[] } | { id: number; ok: false; error: string };

class WorkerDatabase implements LocalDatabase {
  #worker: Worker;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }
  >();
  #releaseLock: (() => void) | null;

  constructor(worker: Worker, releaseLock: (() => void) | null) {
    this.#worker = worker;
    this.#releaseLock = releaseLock;

    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const waiting = this.#pending.get(response.id);
      if (!waiting) return;
      this.#pending.delete(response.id);
      if (response.ok) waiting.resolve(response.rows ?? []);
      else waiting.reject(new Error(response.error));
    };
  }

  #send(request: Record<string, unknown>): Promise<unknown[]> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id });
    });
  }

  /** Installs the VFS and opens the file. Everything else assumes this ran. */
  async open(): Promise<void> {
    await this.#send({ op: 'open' });
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.#send({ op: 'all', sql, params })) as T[];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.#send({ op: 'run', sql, params });
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.#send({ op: 'transaction', statements });
  }

  async close(): Promise<void> {
    await this.#send({ op: 'close' }).catch(() => []);
    this.#worker.terminate();
    this.#releaseLock?.();
    this.#releaseLock = null;
  }

  async wipe(): Promise<void> {
    await this.#send({ op: 'wipe' });
  }
}

export class WebStorage implements Storage {
  isAvailable(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.storage !== 'undefined' &&
      typeof navigator.storage.getDirectory === 'function' &&
      typeof Worker !== 'undefined'
    );
  }

  async requestPersistence(): Promise<boolean> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
      return false;
    }
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  async isPersisted(): Promise<boolean> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persisted !== 'function') {
      return false;
    }
    try {
      return await navigator.storage.persisted();
    } catch {
      return false;
    }
  }

  async estimate(): Promise<StorageEstimate | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
      return null;
    }
    try {
      const estimate = await navigator.storage.estimate();
      return {
        usageBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? 0,
      };
    } catch {
      return null;
    }
  }

  async open(): Promise<OpenResult> {
    if (!this.isAvailable()) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: 'This browser cannot store records on the device.',
      };
    }

    const lock = await claimDatabaseLock();
    if (!lock.held) {
      return {
        ok: false,
        reason: 'busy',
        detail: 'Vigilo is already open in another tab, which is holding the offline records.',
      };
    }

    const worker = new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' });
    const database = new WorkerDatabase(worker, lock.release);

    try {
      // Installing the VFS and opening the file is the step that can fail, so
      // it happens here and is reported as a reason rather than thrown at
      // whoever called open(). Every other operation assumes it has happened.
      await database.open();
      await database.run('select 1');
    } catch (error) {
      await database.close();
      return { ok: false, reason: 'failed', detail: String(error) };
    }

    return { ok: true, database };
  }
}

/**
 * One tab, one database.
 *
 * The sahpool VFS takes exclusive access handles, so a second tab cannot open
 * the same file and, worse, could drain the outbox alongside the first. The
 * lock turns that race into a stated condition: whoever holds it owns the
 * database, and the loser is told it is the second tab.
 *
 * Held until the page goes away, which releases it automatically.
 */
async function claimDatabaseLock(): Promise<{ held: boolean; release: (() => void) | null }> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    // No Web Locks means nothing to arbitrate with, so carry on and let the
    // VFS decide. Every browser with OPFS also has Web Locks, so this is a
    // theoretical branch rather than a real one.
    return { held: true, release: null };
  }

  return new Promise((resolve) => {
    void navigator.locks
      .request(DB_LOCK, { ifAvailable: true }, (heldLock) => {
        if (heldLock === null) {
          resolve({ held: false, release: null });
          return Promise.resolve();
        }

        // The callback's promise is the lock's lifetime, so it is kept open
        // and resolved by whoever closes the database.
        return new Promise<void>((releaseLock) => {
          resolve({ held: true, release: () => releaseLock() });
        });
      })
      .catch(() => resolve({ held: false, release: null }));
  });
}
