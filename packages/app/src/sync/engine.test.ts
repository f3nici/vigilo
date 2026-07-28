import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OutboxOperation,
  SyncBootstrapResponse,
  SyncChange,
  SyncChangesResponse,
  SyncPushResponse,
} from '@vigilo/shared';
import { LocalStore } from '@/db/local';
import { fakeSecureStore, memoryDatabase } from '@/db/testing';

/**
 * The sync engine, against a real local SQLite and a fake server (doc 05 §9).
 *
 * These are the scenarios doc 05 requires before the PWA ships. The server is
 * faked here because what is under test is the device's behaviour when the
 * connection drops halfway, when a response is lost, and when the same
 * operation is sent three times. The real server's half is covered by the
 * API's own sync suite.
 */

/* ------------------------------------------------------------ the fake server */

/** What the fake server holds, keyed the way the real one is: by op id. */
const applied = new Map<string, number>();
let revision = 100;
let failNextPush: Error | null = null;
let failNextChanges: Error | null = null;
let serverRevision = 100;
let pendingChanges: SyncChange[] = [];

const uploaded: string[] = [];

vi.mock('@/api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },

  syncPush: (operations: OutboxOperation[]): Promise<SyncPushResponse> => {
    if (failNextPush) {
      const error = failNextPush;
      failNextPush = null;
      return Promise.reject(error);
    }

    const results = operations.map((operation) => {
      // Exactly what the real server does: an op id it has seen before is a
      // duplicate, and a duplicate reports the revision it produced first time.
      const seen = applied.get(operation.opId);
      if (seen !== undefined) {
        return { opId: operation.opId, status: 'duplicate' as const, revision: seen };
      }
      revision += 1;
      applied.set(operation.opId, revision);
      return { opId: operation.opId, status: 'applied' as const, revision };
    });

    return Promise.resolve({
      results,
      serverRevision: revision,
      serverTime: '2026-07-28T10:00:00.000Z',
    });
  },

  syncChanges: (since: number): Promise<SyncChangesResponse> => {
    if (failNextChanges) {
      const error = failNextChanges;
      failNextChanges = null;
      return Promise.reject(error);
    }

    const page = pendingChanges.filter((change) => change.revision > since);
    return Promise.resolve({
      changes: page,
      tombstones: [],
      scopeChanges: [],
      nextRevision: page.at(-1)?.revision ?? since,
      hasMore: false,
      serverRevision,
      serverTime: '2026-07-28T10:00:00.000Z',
    });
  },

  syncBootstrap: (): Promise<SyncBootstrapResponse> =>
    Promise.resolve({
      changes: pendingChanges,
      revision: serverRevision,
      serverTime: '2026-07-28T10:00:00.000Z',
      timeZone: 'Australia/Melbourne',
      participantIds: [PARTICIPANT],
      retentionDays: 30,
    }),

  uploadAttachmentBytes: (id: string) => {
    uploaded.push(id);
    return Promise.resolve({ id, uploadState: 'complete' });
  },
}));

const { SyncEngine } = await import('./engine');

const PARTICIPANT = '01930000-0000-7000-8000-00000000a001';

function participantChange(revisionNumber: number, firstName = 'Alice'): SyncChange {
  return {
    entity: 'participant',
    id: PARTICIPANT,
    participantId: PARTICIPANT,
    revision: revisionNumber,
    row: {
      id: PARTICIPANT,
      firstName,
      lastName: 'Smith',
      preferredName: null,
      status: 'active',
      archivedAt: null,
      access: { kind: 'standing', expiresAt: null },
    },
  };
}

function entryOperation(
  opId: string,
  entryId = '01930000-0000-7000-8000-00000000c001',
): OutboxOperation {
  return {
    opId,
    kind: 'check_entry.put',
    participantId: PARTICIPANT,
    windowId: '01930000-0000-7000-8000-00000000b001',
    payload: {
      entryId,
      templateVersionId: '01930000-0000-7000-8000-00000000d001',
      recordedAt: '2026-07-28T09:30:00.000+10:00',
      values: [{ fieldKey: 'urine_output', number: 250 }],
    },
  };
}

const opId = (index: number): string =>
  `01930000-0000-7000-8000-${String(index).padStart(12, '0')}`;

describe('the sync engine', () => {
  let store: LocalStore;
  let engine: InstanceType<typeof SyncEngine>;

  beforeEach(async () => {
    applied.clear();
    revision = 100;
    serverRevision = 100;
    pendingChanges = [];
    failNextPush = null;
    failNextChanges = null;
    uploaded.length = 0;

    store = new LocalStore(memoryDatabase(), fakeSecureStore());
    await store.migrate();
    // A fixed random source, so a jittered retry time is a fact rather than a
    // range the test has to be loose about.
    engine = new SyncEngine(store, () => 0.5);
  });

  /* ------------------------------------------------------------ idempotency */

  describe('idempotency', () => {
    it('sends an operation once and clears it', async () => {
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));

      const result = await engine.push(new Date('2026-07-28T09:30:00.000Z'));

      expect(result.pushed).toBe(1);
      expect(applied.size).toBe(1);
      expect((await store.outboxStatus()).pendingCount).toBe(0);
    });

    it('survives a response lost on the way back', async () => {
      // The server applied it and the device never heard. The retry comes back
      // `duplicate`, which means the same thing as `applied` and clears the
      // queue. This is the single most important property in the design.
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));

      failNextPush = new Error('connection reset');
      await expect(engine.push(new Date('2026-07-28T09:30:00.000Z'))).rejects.toThrow();

      // The operation was applied server-side by the request that "failed".
      applied.set(opId(1), 101);

      const retry = await engine.push(new Date('2026-07-28T11:00:00.000Z'));
      expect(retry.pushed).toBe(1);
      expect(applied.size).toBe(1);
      expect((await store.outboxStatus()).pendingCount).toBe(0);
    });

    it('produces one record however many times the batch is replayed', async () => {
      for (let index = 1; index <= 3; index += 1) {
        await store.enqueue(entryOperation(opId(index)), new Date('2026-07-28T09:00:00.000Z'));
      }

      await engine.push(new Date('2026-07-28T09:30:00.000Z'));
      // A restart with the same operations still queued, which is what a hard
      // refresh mid-push looks like.
      for (let index = 1; index <= 3; index += 1) {
        await store.enqueue(entryOperation(opId(index)), new Date('2026-07-28T09:00:00.000Z'));
      }
      await engine.push(new Date('2026-07-28T09:31:00.000Z'));
      await engine.push(new Date('2026-07-28T09:32:00.000Z'));

      expect(applied.size).toBe(3);
    });
  });

  /* ----------------------------------------------------------- interruption */

  describe('interruption', () => {
    it('leaves the queue intact when a push dies mid-flight', async () => {
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));
      failNextPush = new Error('network down');

      await expect(engine.push(new Date('2026-07-28T09:30:00.000Z'))).rejects.toThrow();

      // Still queued, and deferred rather than retried in a tight loop.
      const status = await store.outboxStatus();
      expect(status.pendingCount).toBe(1);
      expect(await store.readyOperations(new Date('2026-07-28T09:30:01.000Z'), 50)).toHaveLength(0);
      expect(await store.readyOperations(new Date('2026-07-28T09:31:00.000Z'), 50)).toHaveLength(1);
    });

    it('leaves the cursor alone when a pull dies mid-flight', async () => {
      pendingChanges = [participantChange(150)];
      await engine.bootstrap();
      const before = await store.cursor();

      failNextChanges = new Error('network down');
      await expect(engine.pull()).rejects.toThrow();

      expect(await store.cursor()).toBe(before);
    });

    it('replays the page rather than skipping it after an interrupted pull', async () => {
      pendingChanges = [participantChange(150)];
      await engine.bootstrap();

      pendingChanges = [...pendingChanges, participantChange(160, 'Alicia')];
      serverRevision = 160;

      failNextChanges = new Error('network down');
      await expect(engine.pull()).rejects.toThrow();

      const recovered = await engine.pull();
      expect(recovered.pulled).toBeGreaterThan(0);
      const participants = await store.participants<{ firstName: string }>();
      expect(participants[0]?.firstName).toBe('Alicia');
    });
  });

  /* ------------------------------------------------------------- bootstrap */

  describe('bootstrap', () => {
    it('rebuilds when the server revision went backwards', async () => {
      // A database restored from a backup. Walking on from the old cursor would
      // skip everything written since the restore (doc 05 §10).
      pendingChanges = [participantChange(150)];
      await engine.bootstrap();
      expect(await store.cursor()).toBe(100);

      await store.applyPage({
        changes: [],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 99_999,
        at: '2026-07-28T10:00:00.000Z',
      });

      serverRevision = 150;
      const result = await engine.pull();

      expect(result.bootstrapped).toBe(true);
      expect(await store.cursor()).toBe(150);
    });

    it('bootstraps on a first sync rather than asking for changes since nothing', async () => {
      pendingChanges = [participantChange(150)];
      const result = await engine.pull();
      expect(result.bootstrapped).toBe(true);
      expect(await store.participants()).toHaveLength(1);
    });
  });

  /* --------------------------------------------------- the airplane scenario */

  describe('48 hours offline', () => {
    it('lands 24 windows exactly once, including after a replay', async () => {
      const queued: OutboxOperation[] = [];
      for (let index = 1; index <= 24; index += 1) {
        const operation = entryOperation(opId(index), opId(1000 + index));
        queued.push(operation);
        await store.enqueue(operation, new Date('2026-07-26T09:00:00.000Z'));
      }

      expect((await store.outboxStatus()).pendingCount).toBe(24);

      const first = await engine.push(new Date('2026-07-28T09:00:00.000Z'));
      expect(first.pushed).toBe(24);
      expect(applied.size).toBe(24);
      expect((await store.outboxStatus()).pendingCount).toBe(0);

      // The whole queue arriving again after a restart changes nothing.
      for (const operation of queued) {
        await store.enqueue(operation, new Date('2026-07-26T09:00:00.000Z'));
      }
      await engine.push(new Date('2026-07-28T09:05:00.000Z'));
      expect(applied.size).toBe(24);
    });
  });

  /* ------------------------------------------------------------ attachments */

  describe('the attachment queue', () => {
    it('uploads separately and clears only once the server has it', async () => {
      await store.enqueueAttachment({
        attachmentId: opId(90),
        participantId: PARTICIPANT,
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3]),
        now: new Date('2026-07-28T09:00:00.000Z'),
      });

      const result = await engine.push(new Date('2026-07-28T09:30:00.000Z'));

      expect(result.attachments).toBe(1);
      expect(uploaded).toEqual([opId(90)]);
      expect(await store.pendingAttachmentCount()).toBe(0);
    });

    it('does not let a photo hold up a check entry', async () => {
      // A 3 MB image and a 2 KB entry are different queues on purpose. The
      // entry goes first and does not wait for the photo.
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));
      await store.enqueueAttachment({
        attachmentId: opId(90),
        participantId: PARTICIPANT,
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3]),
        now: new Date('2026-07-28T09:00:00.000Z'),
      });

      const result = await engine.push(new Date('2026-07-28T09:30:00.000Z'));
      expect(result.pushed).toBe(1);
      expect(result.attachments).toBe(1);
    });
  });

  /* --------------------------------------------------------- concurrent runs */

  describe('being triggered from several places at once', () => {
    it('runs one pass rather than three', async () => {
      // A timer, a visibility change and a network event within the same
      // second is normal. Three passes would push the same batch three times.
      pendingChanges = [participantChange(150)];
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));

      const [a, b, c] = await Promise.all([
        engine.sync(new Date('2026-07-28T09:30:00.000Z')),
        engine.sync(new Date('2026-07-28T09:30:00.000Z')),
        engine.sync(new Date('2026-07-28T09:30:00.000Z')),
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(applied.size).toBe(1);
    });
  });

  /* ------------------------------------------------------------- being offline */

  describe('being offline', () => {
    it('is not reported as an error', async () => {
      // Doc 06 §7: offline is normal, not a failure. A red banner every time a
      // worker walks into a bedroom teaches them to ignore banners.
      await store.enqueue(entryOperation(opId(1)), new Date('2026-07-28T09:00:00.000Z'));
      failNextPush = new TypeError('Failed to fetch');

      const outcome = await engine.sync(new Date('2026-07-28T09:30:00.000Z'));

      expect(outcome.error).toBeNull();
      expect((await store.outboxStatus()).pendingCount).toBe(1);
    });
  });
});
