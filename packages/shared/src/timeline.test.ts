import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  checkTimelineTime,
  describeTimelineItem,
  groupTimelineByDay,
} from './timeline.js';
import type { CheckWindow } from './windows.js';
import type { DiaryEntry } from './diary.js';

function window(overrides: Partial<CheckWindow>): CheckWindow {
  return {
    id: 'w1',
    participantId: 'p1',
    scheduleId: 's1',
    scheduleName: 'Vent observations',
    segmentId: 'seg1',
    templateVersionId: 'v1',
    templateName: 'Vent observations',
    startsAt: '2026-07-27T22:00:00Z',
    endsAt: '2026-07-28T00:00:00Z',
    expected: true,
    coverageReason: null,
    status: 'pending',
    completedAt: null,
    isLate: false,
    lateByMinutes: null,
    requiredFieldCount: 3,
    filledRequiredCount: 0,
    entryId: null,
    missReason: null,
    ...overrides,
  };
}

function diary(overrides: Partial<DiaryEntry>): DiaryEntry {
  return {
    id: 'd1',
    participantId: 'p1',
    categoryId: 'c1',
    categoryLabel: 'Personal care',
    categoryColour: 'sky',
    body: 'Assisted with shower, good mood throughout.',
    occurredAt: '2026-07-27T22:40:00Z',
    recordedBy: 'u1',
    recordedByName: 'A worker',
    recordedAt: '2026-07-27T23:00:00Z',
    visibleToParticipant: true,
    editedAt: null,
    editCount: 0,
    deletedAt: null,
    attachments: [],
    ...overrides,
  };
}

describe('checkTimelineTime', () => {
  /**
   * A recorded check sits where it was observed, and an unrecorded one where it
   * was owed. A missed 06:00 check belongs at 06:00, not at 08:00 when the
   * window closed and nobody was there.
   */
  it('uses the completion time when there is one, otherwise the window start', () => {
    expect(checkTimelineTime(window({ completedAt: '2026-07-27T23:14:00Z' }))).toBe(
      '2026-07-27T23:14:00Z',
    );
    expect(checkTimelineTime(window({ status: 'missed' }))).toBe('2026-07-27T22:00:00Z');
  });
});

describe('buildTimeline', () => {
  it('interleaves checks and diary, newest first', () => {
    const items = buildTimeline(
      [
        window({ id: 'early', startsAt: '2026-07-27T20:00:00Z', status: 'missed' }),
        window({ id: 'late', completedAt: '2026-07-27T23:14:00Z' }),
      ],
      [diary({ id: 'note' })],
    );

    expect(items.map((item) => item.id)).toEqual(['late', 'note', 'early']);
    expect(items.map((item) => item.kind)).toEqual(['check', 'diary', 'check']);
  });

  it('returns an empty list rather than anything clever when there is nothing', () => {
    expect(buildTimeline([], [])).toEqual([]);
  });

  /** Two things at the same instant must not reshuffle between reloads. */
  it('orders a tie the same way every time', () => {
    const at = '2026-07-27T22:40:00Z';
    const windows = [window({ id: 'w', completedAt: at })];
    const entries = [diary({ id: 'a', occurredAt: at }), diary({ id: 'b', occurredAt: at })];

    const first = buildTimeline(windows, entries).map((item) => item.id);
    const second = buildTimeline(windows, [...entries].reverse()).map((item) => item.id);

    expect(first).toEqual(['w', 'a', 'b']);
    expect(second).toEqual(first);
  });
});

describe('groupTimelineByDay', () => {
  /**
   * The whole reason the timezone is passed in. These two instants are 40
   * minutes apart and land on different UTC dates, but in Melbourne they are
   * both the morning of the 28th, and a worker reading a handover would be
   * baffled to see them under different headings.
   */
  it('groups on the local day, not the UTC one', () => {
    const items = buildTimeline(
      [window({ completedAt: '2026-07-27T23:50:00Z' })],
      [diary({ occurredAt: '2026-07-28T00:10:00Z' })],
    );

    const days = groupTimelineByDay(items, 'Australia/Melbourne');
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe('2026-07-28');

    expect(groupTimelineByDay(items, 'UTC')).toHaveLength(2);
  });

  it('keeps the days in the order the items arrived in', () => {
    const items = buildTimeline(
      [
        window({ id: 'w1', completedAt: '2026-07-28T02:00:00Z' }),
        window({ id: 'w2', completedAt: '2026-07-27T02:00:00Z' }),
      ],
      [],
    );
    expect(groupTimelineByDay(items, 'UTC').map((day) => day.date)).toEqual([
      '2026-07-28',
      '2026-07-27',
    ]);
  });
});

describe('describeTimelineItem', () => {
  it('shows the diary body, cut to a line', () => {
    expect(describeTimelineItem({ kind: 'diary', id: 'd1', at: '', entry: diary({}) })).toBe(
      'Assisted with shower, good mood throughout.',
    );
  });

  it('shows the missed reason when there is one', () => {
    const missed = window({
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
        recordedAt: '2026-07-27T22:10:00Z',
      },
    });
    expect(describeTimelineItem({ kind: 'check', id: 'w1', at: '', window: missed })).toBe(
      'Reason: Participant was asleep',
    );
  });

  it('explains a not-expected window instead of leaving a blank row', () => {
    const notExpected = window({
      status: 'not_expected',
      expected: false,
      coverageReason: 'Outside supported hours',
    });
    expect(describeTimelineItem({ kind: 'check', id: 'w1', at: '', window: notExpected })).toBe(
      'Outside supported hours',
    );
  });

  it('counts what has been filled in on a check in progress', () => {
    const partial = window({ status: 'partial', filledRequiredCount: 2 });
    expect(describeTimelineItem({ kind: 'check', id: 'w1', at: '', window: partial })).toBe(
      '2 of 3 recorded',
    );
  });
});
