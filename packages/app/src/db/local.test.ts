import { beforeEach, describe, expect, it } from 'vitest';
import type { OutboxOperation, SyncChange } from '@vigilo/shared';
import { LocalStore } from './local';
import { fakeSecureStore, memoryDatabase } from './testing';

/**
 * The local database (doc 05 §4, §5 and §8).
 *
 * Run against a real SQLite rather than a mock, so the schema, the upserts and
 * the transaction boundaries are the ones that will run on a phone.
 */
describe('the local database', () => {
  let db: ReturnType<typeof memoryDatabase>;
  let store: LocalStore;

  const PARTICIPANT = '01930000-0000-7000-8000-00000000a001';
  const OTHER = '01930000-0000-7000-8000-00000000a002';

  beforeEach(async () => {
    db = memoryDatabase();
    store = new LocalStore(db, fakeSecureStore());
    await store.migrate();
  });

  function participantChange(id: string, revision: number, firstName = 'Alice'): SyncChange {
    return {
      entity: 'participant',
      id,
      participantId: id,
      revision,
      row: {
        id,
        firstName,
        lastName: 'Smith',
        preferredName: null,
        status: 'active',
        archivedAt: null,
        access: { kind: 'standing', expiresAt: null },
      },
    };
  }

  function windowChange(id: string, participantId: string, revision: number): SyncChange {
    return {
      entity: 'check_window',
      id,
      participantId,
      revision,
      row: {
        id,
        participantId,
        scheduleId: 's1',
        scheduleName: 'Hourly',
        segmentId: null,
        templateVersionId: 'v1',
        templateName: 'Vent obs',
        startsAt: '2026-07-28T09:00:00.000Z',
        endsAt: '2026-07-28T10:00:00.000Z',
        expected: true,
        coverageReason: null,
        status: 'pending',
        completedAt: null,
        isLate: false,
        lateByMinutes: null,
        requiredFieldCount: 2,
        filledRequiredCount: 0,
        entryId: null,
        missReason: null,
      },
    };
  }

  function entryOperation(opId: string): OutboxOperation {
    return {
      opId,
      kind: 'check_entry.put',
      participantId: PARTICIPANT,
      windowId: '01930000-0000-7000-8000-00000000b001',
      payload: {
        entryId: '01930000-0000-7000-8000-00000000c001',
        templateVersionId: '01930000-0000-7000-8000-00000000d001',
        recordedAt: '2026-07-28T09:30:00.000+10:00',
        values: [{ fieldKey: 'urine_output', number: 250 }],
      },
    };
  }

  /* ------------------------------------------------------------- migration */

  describe('migration', () => {
    it('is safe to run twice', async () => {
      await store.migrate();
      await store.migrate();
      expect(await store.cursor()).toBe(0);
    });
  });

  /* ------------------------------------------------------------ applying */

  describe('applying a page', () => {
    it('stores a row and hands it back', async () => {
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 10)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 10,
        at: '2026-07-28T00:00:00.000Z',
      });

      const participants = await store.participants<{ id: string; firstName: string }>();
      expect(participants).toHaveLength(1);
      expect(participants[0]?.firstName).toBe('Alice');
      expect(await store.cursor()).toBe(10);
    });

    it('updates rather than duplicating when a row changes', async () => {
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 10)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 10,
        at: '2026-07-28T00:00:00.000Z',
      });
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 11, 'Alicia')],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 11,
        at: '2026-07-28T00:01:00.000Z',
      });

      const participants = await store.participants<{ firstName: string }>();
      expect(participants).toHaveLength(1);
      expect(participants[0]?.firstName).toBe('Alicia');
    });

    it('deletes a row a tombstone names', async () => {
      const windowId = '01930000-0000-7000-8000-00000000b001';
      await store.applyPage({
        changes: [windowChange(windowId, PARTICIPANT, 12)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 12,
        at: '2026-07-28T00:00:00.000Z',
      });
      expect(await store.windowsBetween('2026-07-28', '2026-07-29')).toHaveLength(1);

      await store.applyPage({
        changes: [],
        tombstones: [
          {
            entity: 'check_window',
            id: windowId,
            participantId: PARTICIPANT,
            deletedAt: '2026-07-28T01:00:00.000Z',
            revision: 13,
          },
        ],
        scopeChanges: [],
        nextRevision: 13,
        at: '2026-07-28T00:02:00.000Z',
      });

      expect(await store.windowsBetween('2026-07-28', '2026-07-29')).toHaveLength(0);
    });

    it('rolls the whole page back when one statement fails', async () => {
      // The cursor must not move when the page did not land. Applying half a
      // page and advancing is how a device silently loses the other half.
      const broken = { ...participantChange(PARTICIPANT, 20) } as SyncChange;
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 10)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 10,
        at: '2026-07-28T00:00:00.000Z',
      });

      await expect(
        store.applyPage({
          changes: [broken],
          tombstones: [
            {
              entity: 'check_window',
              id: 'x',
              participantId: PARTICIPANT,
              deletedAt: 'now',
              revision: 21,
            },
          ],
          scopeChanges: [],
          nextRevision: 21,
          // A non-string breaks the meta write, standing in for any statement
          // in the page failing.
          at: undefined as unknown as string,
        }),
      ).rejects.toThrow();

      expect(await store.cursor()).toBe(10);
    });
  });

  /* ------------------------------------------------------------ revocation */

  describe('a revocation', () => {
    beforeEach(async () => {
      await store.applyPage({
        changes: [
          participantChange(PARTICIPANT, 10),
          participantChange(OTHER, 11, 'Jae'),
          windowChange('01930000-0000-7000-8000-00000000b001', PARTICIPANT, 12),
          windowChange('01930000-0000-7000-8000-00000000b002', OTHER, 13),
        ],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 13,
        at: '2026-07-28T00:00:00.000Z',
      });
    });

    it('drops everything for that participant and nothing for anyone else', async () => {
      const outcome = await store.applyPage({
        changes: [],
        tombstones: [],
        scopeChanges: [
          {
            participantId: OTHER,
            effect: 'revoked',
            at: '2026-07-28T01:00:00.000Z',
            revision: 14,
          },
        ],
        nextRevision: 14,
        at: '2026-07-28T01:00:00.000Z',
      });

      expect(outcome.revoked).toEqual([OTHER]);
      const participants = await store.participants<{ id: string }>();
      expect(participants.map((one) => one.id)).toEqual([PARTICIPANT]);

      const windows = await store.windowsBetween<{ participantId: string }>(
        '2026-07-28',
        '2026-07-29',
      );
      expect(windows.map((one) => one.participantId)).toEqual([PARTICIPANT]);
    });

    it('does not write a row for someone revoked in the same page', async () => {
      // Otherwise the row lands, is deleted on the next page, and in between
      // the device is holding a participant it may not see.
      await store.applyPage({
        changes: [participantChange(OTHER, 15, 'Jae-Won')],
        tombstones: [],
        scopeChanges: [
          {
            participantId: OTHER,
            effect: 'revoked',
            at: '2026-07-28T01:00:00.000Z',
            revision: 14,
          },
        ],
        nextRevision: 15,
        at: '2026-07-28T01:00:00.000Z',
      });

      const participants = await store.participants<{ id: string }>();
      expect(participants.map((one) => one.id)).toEqual([PARTICIPANT]);
    });

    it('leaves the outbox alone, because that care still happened', async () => {
      await store.enqueue({
        ...entryOperation('01930000-0000-7000-8000-00000000e001'),
        participantId: OTHER,
      });

      await store.applyPage({
        changes: [],
        tombstones: [],
        scopeChanges: [
          {
            participantId: OTHER,
            effect: 'revoked',
            at: '2026-07-28T01:00:00.000Z',
            revision: 14,
          },
        ],
        nextRevision: 14,
        at: '2026-07-28T01:00:00.000Z',
      });

      const status = await store.outboxStatus();
      expect(status.pendingCount).toBe(1);
    });
  });

  /* ---------------------------------------------------------------- outbox */

  describe('the outbox', () => {
    const OP = '01930000-0000-7000-8000-00000000e001';

    it('queues an operation once however many times it is offered', async () => {
      const at = new Date('2026-07-28T00:00:00.000Z');
      await store.enqueue(entryOperation(OP), at);
      await store.enqueue(entryOperation(OP), at);
      await store.enqueue(entryOperation(OP), at);

      expect((await store.outboxStatus()).pendingCount).toBe(1);
    });

    it('hands operations back in the order they were made', async () => {
      const first = '01930000-0000-7000-8000-00000000e001';
      const second = '01930000-0000-7000-8000-00000000e002';
      await store.enqueue(entryOperation(first), new Date('2026-07-28T00:00:00.000Z'));
      await store.enqueue(entryOperation(second), new Date('2026-07-28T00:01:00.000Z'));

      const ready = await store.readyOperations(new Date('2026-07-28T02:00:00.000Z'), 50);
      expect(ready.map((one) => one.opId)).toEqual([first, second]);
    });

    it('holds back an operation whose retry is not due yet', async () => {
      await store.enqueue(entryOperation(OP), new Date('2026-07-28T00:00:00.000Z'));
      await store.deferOperation(OP, new Date('2026-07-28T03:00:00.000Z'), 'no signal');

      expect(await store.readyOperations(new Date('2026-07-28T02:00:00.000Z'), 50)).toHaveLength(0);
      expect(await store.readyOperations(new Date('2026-07-28T04:00:00.000Z'), 50)).toHaveLength(1);
    });

    it('takes a rejected operation out of the queue and shows it to a person', async () => {
      await store.enqueue(entryOperation(OP), new Date('2026-07-28T00:00:00.000Z'));
      await store.flagOperation(OP, 'This check form has changed.');

      const status = await store.outboxStatus();
      expect(status.pendingCount).toBe(0);
      expect(status.needsUserCount).toBe(1);

      const flagged = await store.flaggedOperations();
      expect(flagged[0]?.error).toBe('This check form has changed.');
      // And it is not offered for sending again, because retrying cannot help.
      expect(await store.readyOperations(new Date('2026-07-29T00:00:00.000Z'), 50)).toHaveLength(0);
    });

    it('reports the age of the oldest thing waiting', async () => {
      await store.enqueue(entryOperation(OP), new Date('2026-07-27T09:00:00.000Z'));
      const status = await store.outboxStatus();
      expect(status.oldestPendingAt).toBe('2026-07-27T09:00:00.000Z');
    });

    it('clears an operation the server confirmed', async () => {
      await store.enqueue(entryOperation(OP), new Date('2026-07-28T00:00:00.000Z'));
      await store.clearOperations([OP]);
      expect((await store.outboxStatus()).pendingCount).toBe(0);
    });
  });

  /* ------------------------------------------------------ attachment queue */

  describe('the attachment queue', () => {
    const ATTACHMENT = '01930000-0000-7000-8000-00000000f001';

    it('holds the bytes until the server confirms it has them', async () => {
      await store.enqueueAttachment({
        attachmentId: ATTACHMENT,
        participantId: PARTICIPANT,
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3, 4]),
        now: new Date('2026-07-28T00:00:00.000Z'),
      });

      const ready = await store.readyAttachments(new Date('2026-07-28T02:00:00.000Z'), 5);
      expect(ready).toHaveLength(1);
      expect(Array.from(ready[0]!.bytes)).toEqual([1, 2, 3, 4]);

      await store.clearAttachment(ATTACHMENT);
      expect(await store.pendingAttachmentCount()).toBe(0);
    });

    it('does not queue the same photo twice', async () => {
      const bytes = new Uint8Array([9]);
      await store.enqueueAttachment({
        attachmentId: ATTACHMENT,
        participantId: PARTICIPANT,
        mimeType: 'image/jpeg',
        bytes,
      });
      await store.enqueueAttachment({
        attachmentId: ATTACHMENT,
        participantId: PARTICIPANT,
        mimeType: 'image/jpeg',
        bytes,
      });

      expect(await store.pendingAttachmentCount()).toBe(1);
    });
  });

  /* ------------------------------------------------------------ ownership */

  describe('whose device this is', () => {
    it('throws away a database belonging to somebody else', async () => {
      // Two workers share a phone on a handover. The second must never see the
      // first's participants.
      await store.claimFor('user-a');
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 10)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 10,
        at: '2026-07-28T00:00:00.000Z',
      });

      expect(await store.userId()).toBe('user-a');
      await store.wipe();
      await store.claimFor('user-b');

      expect(await store.participants()).toHaveLength(0);
      expect(await store.cursor()).toBe(0);
      expect(await store.userId()).toBe('user-b');
    });

    it('reports an empty database, which is how eviction is detected', async () => {
      expect(await store.isEmpty()).toBe(true);
      await store.applyPage({
        changes: [participantChange(PARTICIPANT, 10)],
        tombstones: [],
        scopeChanges: [],
        nextRevision: 10,
        at: '2026-07-28T00:00:00.000Z',
      });
      expect(await store.isEmpty()).toBe(false);
    });
  });
});
