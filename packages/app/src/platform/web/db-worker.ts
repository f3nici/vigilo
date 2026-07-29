/// <reference lib="webworker" />
import sqlite3InitModule, {
  type BindingSpec,
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';

/**
 * SQLite over OPFS, in a dedicated worker (doc 05 §8).
 *
 * A worker rather than the main thread because Safari only hands out
 * synchronous access handles to a worker, and because a query that scans a
 * month of windows must not stutter a form somebody is typing into.
 *
 * The `opfs-sahpool` VFS rather than the original `opfs` one: the original
 * needs SharedArrayBuffer, which needs cross-origin isolation, which would tax
 * every cross-origin resource the product ever loads. The price of sahpool is
 * that one tab owns the database at a time, which the Storage adapter handles
 * with a Web Lock.
 *
 * This file speaks a tiny request/response protocol and holds no product
 * knowledge. The schema and the queries live above the platform boundary.
 */

type Request =
  | { id: number; op: 'open' }
  | { id: number; op: 'all'; sql: string; params: readonly unknown[] }
  | { id: number; op: 'run'; sql: string; params: readonly unknown[] }
  | { id: number; op: 'transaction'; statements: { sql: string; params?: readonly unknown[] }[] }
  | { id: number; op: 'wipe' }
  | { id: number; op: 'close' };

type Response =
  { id: number; ok: true; rows?: unknown[] } | { id: number; ok: false; error: string };

const DB_NAME = 'vigilo.sqlite3';

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;

async function open(): Promise<void> {
  if (db) return;

  sqlite3 ??= await sqlite3InitModule();

  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'vigilo-opfs' });
  db = new poolUtil.OpfsSAHPoolDb(`/${DB_NAME}`);

  // WAL is not available on this VFS, and neither is it wanted: one writer at
  // a time is exactly the model here.
  db.exec('PRAGMA foreign_keys = ON');
}

function requireDb(): Database {
  if (!db) throw new Error('The local database is not open.');
  return db;
}

/** Params cross a postMessage boundary as plain JSON, so they arrive untyped. */
function bind(params: readonly unknown[]): BindingSpec {
  return params as BindingSpec;
}

function all(sql: string, params: readonly unknown[]): unknown[] {
  return requireDb().exec(sql, {
    bind: bind(params),
    returnValue: 'resultRows',
    rowMode: 'object',
  });
}

function run(sql: string, params: readonly unknown[]): void {
  requireDb().exec(sql, { bind: bind(params), returnValue: 'this', rowMode: 'array' });
}

/**
 * All or nothing.
 *
 * A sync page lands through here. Applying half a page and advancing the
 * cursor would lose the other half silently, which is the failure this whole
 * design exists to prevent.
 */
function transaction(statements: { sql: string; params?: readonly unknown[] }[]): void {
  const database = requireDb();
  database.exec('BEGIN');
  try {
    for (const statement of statements) {
      database.exec(statement.sql, {
        bind: bind(statement.params ?? []),
        returnValue: 'this',
        rowMode: 'array',
      });
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function wipe(): Promise<void> {
  db?.close();
  db = null;

  sqlite3 ??= await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'vigilo-opfs' });
  await poolUtil.wipeFiles();
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;

  void (async (): Promise<void> => {
    try {
      switch (request.op) {
        case 'open':
          await open();
          reply({ id: request.id, ok: true });
          return;
        case 'all':
          reply({ id: request.id, ok: true, rows: all(request.sql, request.params) });
          return;
        case 'run':
          run(request.sql, request.params);
          reply({ id: request.id, ok: true });
          return;
        case 'transaction':
          transaction(request.statements);
          reply({ id: request.id, ok: true });
          return;
        case 'wipe':
          await wipe();
          reply({ id: request.id, ok: true });
          return;
        case 'close':
          db?.close();
          db = null;
          reply({ id: request.id, ok: true });
          return;
      }
    } catch (error) {
      reply({ id: request.id, ok: false, error: String(error) });
    }
  })();
};

function reply(response: Response): void {
  self.postMessage(response);
}
