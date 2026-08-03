import { describe, expect, it } from 'vitest';
import {
  backfillNeedsApproval,
  countsTowardCompliance,
  describeOutstanding,
  describeWindowStatus,
  emptyOutstanding,
  hasOutstanding,
  isLate,
  lateByMinutes,
  needsMissReason,
  nextWindowStatus,
  summariseOutstanding,
  windowSortRank,
  type CheckWindow,
} from './windows.js';

const ENDS_AT = new Date('2026-07-27T10:00:00Z');
const DURING = new Date('2026-07-27T09:30:00Z');
const AFTER = new Date('2026-07-27T10:30:00Z');

function status(overrides: Partial<Parameters<typeof nextWindowStatus>[0]> = {}) {
  return nextWindowStatus({
    expected: true,
    hasEntry: false,
    entryComplete: false,
    endsAt: ENDS_AT,
    now: DURING,
    ...overrides,
  });
}

describe('window state machine', () => {
  it('starts pending while it is open', () => {
    expect(status()).toBe('pending');
  });

  it('goes partial on the first value', () => {
    expect(status({ hasEntry: true })).toBe('partial');
  });

  it('goes complete when every required field is filled', () => {
    expect(status({ hasEntry: true, entryComplete: true })).toBe('complete');
  });

  it('goes missed when it closes with nothing recorded', () => {
    expect(status({ now: AFTER })).toBe('missed');
  });

  it('goes missed when it closes part recorded', () => {
    expect(status({ hasEntry: true, now: AFTER })).toBe('missed');
  });

  it('is not_expected when coverage says nobody was there', () => {
    expect(status({ expected: false })).toBe('not_expected');
    expect(status({ expected: false, now: AFTER })).toBe('not_expected');
  });

  /** Doc 03 §5: a worker who is there anyway can still record. */
  it('flips a not_expected window to complete when someone records anyway', () => {
    expect(status({ expected: false, hasEntry: true, entryComplete: true })).toBe('complete');
  });

  it('never marks a not_expected window as missed', () => {
    expect(status({ expected: false, hasEntry: true, now: AFTER })).toBe('partial');
  });

  /**
   * `missed` is not terminal. A late entry completes the window, and the
   * lateness and the miss reason both stay on the record.
   */
  it('lets a late entry complete a missed window', () => {
    expect(status({ hasEntry: true, entryComplete: true, now: AFTER })).toBe('complete');
  });
});

describe('compliance and prompts', () => {
  it('excludes not_expected from compliance', () => {
    expect(countsTowardCompliance('not_expected')).toBe(false);
    expect(countsTowardCompliance('missed')).toBe(true);
    expect(countsTowardCompliance('complete')).toBe(true);
  });

  it('asks for a reason only on an unresolved missed window', () => {
    expect(needsMissReason('missed', false)).toBe(true);
    expect(needsMissReason('missed', true)).toBe(false);
    expect(needsMissReason('pending', false)).toBe(false);
    expect(needsMissReason('not_expected', false)).toBe(false);
  });

  it('puts anything needing a reason at the top of Today', () => {
    const ranks = [
      windowSortRank({ status: 'complete', missReason: null }),
      windowSortRank({ status: 'missed', missReason: null }),
      windowSortRank({ status: 'pending', missReason: null }),
      windowSortRank({ status: 'missed', missReason: {} }),
      windowSortRank({ status: 'not_expected', missReason: null }),
    ];
    expect(ranks).toEqual([3, 0, 1, 2, 4]);
  });
});

describe('lateness', () => {
  it('measures from the server clock against the window close', () => {
    expect(isLate(ENDS_AT, DURING)).toBe(false);
    expect(isLate(ENDS_AT, ENDS_AT)).toBe(false);
    expect(isLate(ENDS_AT, AFTER)).toBe(true);
    expect(lateByMinutes(ENDS_AT, AFTER)).toBe(30);
    expect(lateByMinutes(ENDS_AT, DURING)).toBe(0);
  });

  it('rounds a part minute up, so 30 seconds late is a minute late', () => {
    expect(lateByMinutes(ENDS_AT, new Date('2026-07-27T10:00:30Z'))).toBe(1);
  });

  it('needs a team leader past the back-fill cut-off', () => {
    const dayLater = new Date('2026-07-28T10:30:00Z');
    expect(backfillNeedsApproval(ENDS_AT, AFTER, 1440)).toBe(false);
    expect(backfillNeedsApproval(ENDS_AT, dayLater, 1440)).toBe(true);
  });
});

describe('descriptions', () => {
  it('uses plain words', () => {
    expect(describeWindowStatus('pending')).toBe('Not started');
    expect(describeWindowStatus('not_expected')).toBe('Not expected');
  });
});

describe('what is outstanding on a participant', () => {
  /**
   * D90. The worker home is the participant list now, so the list has to
   * answer the question Today used to: which of these people needs me. A
   * missed check nobody notices is the failure the product exists to prevent.
   */
  const NOW = new Date('2026-08-02T10:00:00Z');

  function win(overrides: Partial<CheckWindow>): CheckWindow {
    return {
      id: 'w',
      participantId: 'aroha',
      scheduleId: 's',
      scheduleName: 'Vent',
      segmentId: null,
      templateVersionId: 'v',
      templateName: 'Vent',
      startsAt: '2026-08-02T09:00:00Z',
      endsAt: '2026-08-02T11:00:00Z',
      expected: true,
      coverageReason: null,
      status: 'pending',
      completedAt: null,
      isLate: false,
      lateByMinutes: null,
      requiredFieldCount: 1,
      filledRequiredCount: 0,
      entryId: null,
      missReason: null,
      ...overrides,
    } as CheckWindow;
  }

  it('counts a missed window with no reason as owing one', () => {
    const counts = summariseOutstanding([win({ status: 'missed' })], NOW).get('aroha');
    expect(counts).toEqual({ needsReason: 1, openNow: 0, missedExplained: 0 });
  });

  it('counts a missed window that has been explained separately', () => {
    // Still worth showing: the row should not look clean because somebody
    // wrote down why.
    const explained = win({
      status: 'missed',
      missReason: { label: 'Participant was asleep' } as CheckWindow['missReason'],
    });
    expect(summariseOutstanding([explained], NOW).get('aroha')).toEqual({
      needsReason: 0,
      openNow: 0,
      missedExplained: 1,
    });
  });

  it('counts a window that is open right now', () => {
    expect(summariseOutstanding([win({})], NOW).get('aroha')?.openNow).toBe(1);
  });

  it('ignores one that has not opened yet or has already been done', () => {
    const later = win({ startsAt: '2026-08-02T14:00:00Z', endsAt: '2026-08-02T16:00:00Z' });
    const done = win({ status: 'complete' });
    const notExpected = win({ status: 'not_expected', expected: false });

    const counts = summariseOutstanding([later, done, notExpected], NOW).get('aroha');
    expect(counts).toEqual({ needsReason: 0, openNow: 0, missedExplained: 0 });
  });

  it('keeps each participant separate', () => {
    const map = summariseOutstanding(
      [win({ status: 'missed' }), win({ participantId: 'sam', status: 'complete' })],
      NOW,
    );
    expect(map.get('aroha')?.needsReason).toBe(1);
    expect(map.get('sam')).toEqual({ needsReason: 0, openNow: 0, missedExplained: 0 });
  });

  it('says nothing when there is nothing to say', () => {
    expect(hasOutstanding(emptyOutstanding())).toBe(false);
    expect(describeOutstanding(emptyOutstanding())).toBeNull();
  });

  it('reads as words, with what is owed first', () => {
    // Colour is never the only signal, so the row spells the counts out.
    expect(describeOutstanding({ needsReason: 2, openNow: 1, missedExplained: 3 })).toBe(
      '2 checks need a reason · 1 due now · 3 missed',
    );
    expect(describeOutstanding({ needsReason: 1, openNow: 0, missedExplained: 0 })).toBe(
      '1 check needs a reason',
    );
  });
});
