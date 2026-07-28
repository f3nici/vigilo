import { describe, expect, it } from 'vitest';
import {
  BACKOFF_STEP_COUNT,
  backoffDelayMs,
  clockSkewIsSignificant,
  describeSyncState,
  isBeyondDeviceRetention,
  isOrgWideEntity,
  needsBootstrap,
  outboxDisposition,
  outboxOperationSchema,
  shouldSurfaceToUser,
  sortForApply,
  syncChangeSchema,
  syncIndicatorState,
  withJitter,
  type SyncStatus,
} from './sync.js';

const now = new Date('2026-07-28T10:00:00.000Z');

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    online: true,
    pendingCount: 0,
    needsUserCount: 0,
    oldestPendingAt: null,
    lastSyncAt: null,
    ...overrides,
  };
}

describe('apply order', () => {
  it('orders by revision first', () => {
    const sorted = sortForApply([
      { entity: 'diary_entry' as const, revision: 9 },
      { entity: 'diary_category' as const, revision: 4 },
    ]);
    expect(sorted.map((change) => change.revision)).toEqual([4, 9]);
  });

  it('puts a category before a diary entry written in the same transaction', () => {
    // Two rows can share a revision when one statement touches both. Applying
    // the entry first would leave it pointing at a category the device does
    // not have yet.
    const sorted = sortForApply([
      { entity: 'diary_entry' as const, revision: 12 },
      { entity: 'diary_category' as const, revision: 12 },
    ]);
    expect(sorted.map((change) => change.entity)).toEqual(['diary_category', 'diary_entry']);
  });

  it('puts a window before the entry recorded against it', () => {
    const sorted = sortForApply([
      { entity: 'check_entry' as const, revision: 3 },
      { entity: 'check_window' as const, revision: 3 },
    ]);
    expect(sorted.map((change) => change.entity)).toEqual(['check_window', 'check_entry']);
  });
});

describe('org-wide entities', () => {
  it('does not drop reference data on a revocation', () => {
    expect(isOrgWideEntity('diary_category')).toBe(true);
    expect(isOrgWideEntity('check_template_version')).toBe(true);
    expect(isOrgWideEntity('missed_reason_code')).toBe(true);
  });

  it('treats participant data as droppable', () => {
    expect(isOrgWideEntity('diary_entry')).toBe(false);
    expect(isOrgWideEntity('check_window')).toBe(false);
    expect(isOrgWideEntity('participant')).toBe(false);
  });
});

describe('bootstrap detection', () => {
  it('forces a bootstrap when the server revision went backwards', () => {
    // A database restored from a backup hands out revisions the device has
    // already seen. Walking on from the old cursor would skip everything
    // written since the restore.
    expect(needsBootstrap(84_102, 12)).toBe(true);
  });

  it('leaves a normal cursor alone', () => {
    expect(needsBootstrap(84_102, 84_610)).toBe(false);
    expect(needsBootstrap(84_102, 84_102)).toBe(false);
  });
});

describe('backoff', () => {
  it('walks the documented steps', () => {
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(15_000);
    expect(backoffDelayMs(3)).toBe(60_000);
    expect(backoffDelayMs(4)).toBe(300_000);
    expect(backoffDelayMs(5)).toBe(900_000);
    expect(backoffDelayMs(6)).toBe(3_600_000);
  });

  it('stays hourly after that rather than growing without bound', () => {
    expect(backoffDelayMs(7)).toBe(3_600_000);
    expect(backoffDelayMs(400)).toBe(3_600_000);
    expect(BACKOFF_STEP_COUNT).toBe(6);
  });

  it('does not wait before the first attempt', () => {
    expect(backoffDelayMs(0)).toBe(0);
  });

  it('jitters between half and full', () => {
    expect(withJitter(1000, () => 0)).toBe(500);
    expect(withJitter(1000, () => 0.999999)).toBe(1000);
  });

  it('surfaces an operation that has been failing for a day', () => {
    expect(shouldSurfaceToUser('2026-07-27T09:59:00.000Z', now)).toBe(true);
    expect(shouldSurfaceToUser('2026-07-28T00:00:00.000Z', now)).toBe(false);
  });
});

describe('push results', () => {
  it('clears the outbox for applied and for duplicate alike', () => {
    // The equivalence is the whole reason retrying is safe. A response lost on
    // a flaky connection comes back as duplicate on the retry, and that has to
    // mean the same thing as applied.
    expect(outboxDisposition({ opId: 'a', status: 'applied', revision: 1 })).toBe('clear');
    expect(outboxDisposition({ opId: 'a', status: 'duplicate', revision: 1 })).toBe('clear');
  });

  it('holds a rejected operation for a person to look at', () => {
    expect(
      outboxDisposition({
        opId: 'a',
        status: 'rejected',
        error: { code: 'template_version_mismatch', message: 'The form changed.' },
      }),
    ).toBe('needs_user');
  });
});

describe('the indicator', () => {
  it('says synced with an empty queue and a connection', () => {
    expect(syncIndicatorState(status(), now)).toBe('synced');
    expect(describeSyncState(status(), now)).toBe('Synced');
  });

  it('states being offline as a fact, not a failure', () => {
    const offline = status({ online: false });
    expect(syncIndicatorState(offline, now)).toBe('offline');
    expect(describeSyncState(offline, now)).toBe('Offline, everything saved');
  });

  it('counts what is waiting while offline', () => {
    const offline = status({ online: false, pendingCount: 3, oldestPendingAt: now.toISOString() });
    expect(describeSyncState(offline, now)).toBe('Offline, 3 records waiting');
  });

  it('calls for attention once something has waited a day', () => {
    const stale = status({ pendingCount: 1, oldestPendingAt: '2026-07-27T09:00:00.000Z' });
    expect(syncIndicatorState(stale, now)).toBe('needs_attention');
    expect(describeSyncState(stale, now)).toBe('Waiting to send for over a day');
  });

  it('calls for attention when the server rejected something', () => {
    const rejected = status({ needsUserCount: 2 });
    expect(syncIndicatorState(rejected, now)).toBe('needs_attention');
    expect(describeSyncState(rejected, now)).toBe('2 records need attention');
  });

  it('uses the singular for one record', () => {
    expect(describeSyncState(status({ needsUserCount: 1 }), now)).toBe('1 record needs attention');
    expect(
      describeSyncState(status({ pendingCount: 1, oldestPendingAt: now.toISOString() }), now),
    ).toBe('Sending 1 record');
  });
});

describe('device retention', () => {
  it('keeps 30 days of records', () => {
    expect(isBeyondDeviceRetention('2026-07-01T10:00:00.000Z', now)).toBe(false);
    expect(isBeyondDeviceRetention('2026-06-01T10:00:00.000Z', now)).toBe(true);
  });
});

describe('clock skew', () => {
  it('warns past five minutes in either direction', () => {
    expect(clockSkewIsSignificant(3 * 60 * 60 * 1000)).toBe(true);
    expect(clockSkewIsSignificant(-3 * 60 * 60 * 1000)).toBe(true);
    expect(clockSkewIsSignificant(60 * 1000)).toBe(false);
  });
});

describe('the wire shapes', () => {
  it('accepts an entry recorded with no window after a long outage', () => {
    const parsed = outboxOperationSchema.safeParse({
      opId: '01930000-0000-7000-8000-000000000001',
      kind: 'check_entry.put',
      participantId: '01930000-0000-7000-8000-000000000002',
      windowId: null,
      payload: {
        entryId: '01930000-0000-7000-8000-000000000003',
        templateVersionId: '01930000-0000-7000-8000-000000000004',
        recordedAt: '2026-07-28T09:00:00.000+10:00',
        values: [{ fieldKey: 'pulse', number: 72 }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an operation with no op id, because that is what makes a replay safe', () => {
    const parsed = outboxOperationSchema.safeParse({
      kind: 'miss_reason.put',
      participantId: '01930000-0000-7000-8000-000000000002',
      windowId: '01930000-0000-7000-8000-000000000005',
      payload: { reasonCodeId: '01930000-0000-7000-8000-000000000006' },
    });
    expect(parsed.success).toBe(false);
  });

  it('has no operation for a window, because devices never create them', () => {
    const parsed = outboxOperationSchema.safeParse({
      opId: '01930000-0000-7000-8000-000000000001',
      kind: 'check_window.put',
      participantId: '01930000-0000-7000-8000-000000000002',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('carries the participant id on a change so a revocation can find it', () => {
    const parsed = syncChangeSchema.safeParse({
      entity: 'diary_category',
      id: 'cat-1',
      participantId: null,
      revision: 12,
      row: {
        id: 'cat-1',
        slug: 'medical',
        label: 'Medical',
        colour: 'teal',
        active: true,
        sortOrder: 0,
      },
    });
    expect(parsed.success).toBe(true);
  });
});
