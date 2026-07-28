import { DatabaseSync } from 'node:sqlite';
import type { LocalDatabase, SecureStore, SqlStatement, UnlockMethod } from '@/platform';

/**
 * A real SQLite behind the same interface the platform adapter provides.
 *
 * Test-only, and worth the small amount of code: it means the local schema,
 * every statement in local.ts and the transaction semantics are exercised
 * against an actual database rather than against a mock that agrees with
 * whatever the code does. Node's own SQLite is the same engine the WASM build
 * compiles, so a query that works here works on a phone.
 */
export function memoryDatabase(): LocalDatabase & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  const bind = (params: readonly unknown[]): unknown[] =>
    params.map((value) => {
      if (value === undefined || value === null) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });

  return {
    raw: db,

    all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return Promise.resolve(db.prepare(sql).all(...(bind(params) as never[])) as T[]);
    },

    run(sql: string, params: readonly unknown[] = []): Promise<void> {
      db.prepare(sql).run(...(bind(params) as never[]));
      return Promise.resolve();
    },

    transaction(statements: readonly SqlStatement[]): Promise<void> {
      db.exec('BEGIN');
      try {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...(bind(statement.params ?? []) as never[]));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return Promise.resolve();
    },

    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },

    wipe(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/**
 * A secure store that seals reversibly without a key.
 *
 * The real one is tested separately against WebCrypto. Here the point is that
 * every value written to the local database goes through a seal and comes back
 * through an unseal, so a query that forgets to unseal fails loudly instead of
 * looking like it worked.
 */
export function fakeSecureStore(): SecureStore & { failFor?: string } {
  let unlocked = true;

  return {
    isAvailable: () => Promise.resolve(true),
    isEnrolled: () => Promise.resolve(true),
    enrolledMethod: () => Promise.resolve<UnlockMethod | null>('pin'),
    enrolBiometric: () => Promise.resolve(true),
    enrolPin: () => Promise.resolve(),
    unlockWithBiometric: () => {
      unlocked = true;
      return Promise.resolve(true);
    },
    unlockWithPin: () => {
      unlocked = true;
      return Promise.resolve(true);
    },
    isUnlocked: () => unlocked,
    method: () => 'pin',
    lock: () => {
      unlocked = false;
    },
    reset: () => Promise.resolve(),
    set: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    remove: () => Promise.resolve(),

    seal: (value: string) => {
      if (!unlocked) return Promise.reject(new Error('Vigilo is locked.'));
      return Promise.resolve(`sealed:${Buffer.from(value).toString('base64')}`);
    },
    unseal: (sealed: string) => {
      if (!unlocked) return Promise.reject(new Error('Vigilo is locked.'));
      if (!sealed.startsWith('sealed:')) return Promise.reject(new Error('Not sealed.'));
      return Promise.resolve(Buffer.from(sealed.slice(7), 'base64').toString());
    },
  };
}
