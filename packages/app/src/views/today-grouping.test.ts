import { describe, expect, it } from 'vitest';
import { needsMissReason, type CheckWindow } from '@vigilo/shared';

/**
 * Today's grouping (doc 06 §3).
 *
 * The rule under test is exhaustiveness: every window the feed returns lands in
 * exactly one group. An earlier version grouped on status as well as time, so a
 * not-expected window that was open right now matched neither "pending or
 * partial" nor "already closed" and rendered nowhere. A window silently missing
 * from this screen is the failure that showing them greyed exists to prevent.
 *
 * The predicates are duplicated here rather than imported because they live
 * inside a `<script setup>` block. If TodayView changes, this test has to be
 * changed with it, which is the reminder that matters.
 */
const NOW = new Date('2026-07-27T11:52:00Z');

function isNeedsAttention(window: CheckWindow): boolean {
  return needsMissReason(window.status, window.missReason !== null);
}

function isDueNow(window: CheckWindow): boolean {
  return new Date(window.startsAt) <= NOW && new Date(window.endsAt) > NOW;
}

function isLater(window: CheckWindow): boolean {
  return new Date(window.startsAt) > NOW;
}

function isDone(window: CheckWindow): boolean {
  return new Date(window.endsAt) <= NOW && !isNeedsAttention(window);
}

function window(overrides: Partial<CheckWindow>): CheckWindow {
  return {
    id: 'w1',
    participantId: 'p1',
    scheduleId: 's1',
    scheduleName: 'Vent observations',
    segmentId: 'seg1',
    templateVersionId: 'v1',
    templateName: 'Vent observations',
    startsAt: '2026-07-27T11:00:00Z',
    endsAt: '2026-07-27T15:00:00Z',
    expected: true,
    coverageReason: null,
    status: 'pending',
    completedAt: null,
    isLate: false,
    lateByMinutes: null,
    requiredFieldCount: 2,
    filledRequiredCount: 0,
    entryId: null,
    recordedByName: null,
    missReason: null,
    ...overrides,
  };
}

/** Needs-attention is a pin to the top, so a row may be in it and one other. */
function groupsFor(one: CheckWindow): string[] {
  const groups: string[] = [];
  if (isNeedsAttention(one)) groups.push('needsAttention');
  if (isDueNow(one)) groups.push('dueNow');
  if (isLater(one)) groups.push('later');
  if (isDone(one)) groups.push('done');
  return groups;
}

describe('Today grouping', () => {
  it('puts an open window in due now', () => {
    expect(groupsFor(window({ status: 'pending' }))).toEqual(['dueNow']);
    expect(groupsFor(window({ status: 'partial' }))).toEqual(['dueNow']);
  });

  /** The bug this file exists for. */
  it('shows a not-expected window that is open right now', () => {
    const openButNotExpected = window({
      status: 'not_expected',
      expected: false,
      coverageReason: 'Outside supported hours',
    });
    expect(groupsFor(openButNotExpected)).toEqual(['dueNow']);
  });

  it('puts a future window in later, whatever its status', () => {
    const future = { startsAt: '2026-07-27T20:00:00Z', endsAt: '2026-07-28T00:00:00Z' };
    expect(groupsFor(window(future))).toEqual(['later']);
    expect(groupsFor(window({ ...future, status: 'not_expected', expected: false }))).toEqual([
      'later',
    ]);
  });

  it('puts a finished window in done', () => {
    const past = { startsAt: '2026-07-27T03:00:00Z', endsAt: '2026-07-27T07:00:00Z' };
    expect(groupsFor(window({ ...past, status: 'complete' }))).toEqual(['done']);
    expect(groupsFor(window({ ...past, status: 'not_expected', expected: false }))).toEqual([
      'done',
    ]);
  });

  it('pins a missed window with no reason to the top and nowhere else', () => {
    const missed = window({
      startsAt: '2026-07-27T03:00:00Z',
      endsAt: '2026-07-27T07:00:00Z',
      status: 'missed',
    });
    expect(groupsFor(missed)).toEqual(['needsAttention']);
  });

  it('moves a missed window into done once a reason is given', () => {
    const resolved = window({
      startsAt: '2026-07-27T03:00:00Z',
      endsAt: '2026-07-27T07:00:00Z',
      status: 'missed',
      missReason: {
        id: 'm1',
        windowId: 'w1',
        reasonCodeId: 'r1',
        code: 'asleep',
        label: 'Participant was asleep',
        note: null,
        recordedBy: 'u1',
        recordedByName: 'A worker',
        recordedAt: '2026-07-27T08:00:00Z',
      },
    });
    expect(groupsFor(resolved)).toEqual(['done']);
  });

  /** Every window the feed can return renders somewhere. */
  it('leaves nothing ungrouped', () => {
    const spans = [
      { startsAt: '2026-07-27T03:00:00Z', endsAt: '2026-07-27T07:00:00Z' },
      { startsAt: '2026-07-27T11:00:00Z', endsAt: '2026-07-27T15:00:00Z' },
      { startsAt: '2026-07-27T20:00:00Z', endsAt: '2026-07-28T00:00:00Z' },
    ];
    const statuses = ['pending', 'partial', 'complete', 'missed', 'not_expected'] as const;

    for (const span of spans) {
      for (const status of statuses) {
        const one = window({ ...span, status });
        expect(groupsFor(one).length, `${status} ${span.startsAt}`).toBeGreaterThan(0);
      }
    }
  });
});
