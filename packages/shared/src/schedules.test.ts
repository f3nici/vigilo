import { describe, expect, it } from 'vitest';
import {
  describeSegment,
  describeWeekdays,
  formatWindowRange,
  generateDayWindows,
  generateSegmentWindows,
  segmentSpan,
  segmentWeekIntervals,
  validateSegments,
  type SegmentInput,
} from './schedules.js';
import { totalLength } from './intervals.js';

const MELBOURNE = 'Australia/Melbourne';

function segment(overrides: Partial<SegmentInput> = {}): SegmentInput {
  return {
    windowMinutes: 120,
    anchorTime: '07:00',
    appliesFromTime: '07:00',
    appliesToTime: '21:00',
    weekdays: null,
    sortOrder: 0,
    label: null,
    ...overrides,
  };
}

function ranges(windows: { startMinutes: number; endMinutes: number }[]): string[] {
  return windows.map(formatWindowRange);
}

describe('segment spans', () => {
  it('reads a plain daytime range', () => {
    expect(segmentSpan(segment())).toEqual({ from: 420, to: 1260 });
  });

  it('runs an overnight range into the next day', () => {
    const overnight = segment({ appliesFromTime: '21:00', appliesToTime: '07:00' });
    expect(segmentSpan(overnight)).toEqual({ from: 1260, to: 1860 });
  });

  it('treats 24:00 as the end of the day', () => {
    expect(segmentSpan(segment({ appliesFromTime: '00:00', appliesToTime: '24:00' }))).toEqual({
      from: 0,
      to: 1440,
    });
  });
});

describe('grid generation', () => {
  it('lays 2-hourly windows from the anchor', () => {
    const windows = generateSegmentWindows(segment(), '2026-07-27', MELBOURNE);
    expect(ranges(windows)).toEqual([
      '07:00–09:00',
      '09:00–11:00',
      '11:00–13:00',
      '13:00–15:00',
      '15:00–17:00',
      '17:00–19:00',
      '19:00–21:00',
    ]);
  });

  it('produces real instants in the org timezone', () => {
    const [first] = generateSegmentWindows(segment(), '2026-07-27', MELBOURNE);
    expect(first?.startsAt.toISOString()).toBe('2026-07-26T21:00:00.000Z');
    expect(first?.endsAt.toISOString()).toBe('2026-07-26T23:00:00.000Z');
  });

  it('carries an overnight segment into the next morning', () => {
    const overnight = segment({
      windowMinutes: 240,
      anchorTime: '21:00',
      appliesFromTime: '21:00',
      appliesToTime: '07:00',
    });
    const windows = generateSegmentWindows(overnight, '2026-07-27', MELBOURNE);
    expect(ranges(windows)).toEqual(['21:00–01:00', '01:00–05:00', '05:00–07:00']);
    expect(windows[2]?.endsAt.toISOString()).toBe('2026-07-27T21:00:00.000Z');
  });

  it('clips the final window rather than running past the segment', () => {
    // 21:00 to 07:00 is 10 hours, which a 4 hour window does not divide.
    const windows = generateSegmentWindows(
      segment({
        windowMinutes: 240,
        anchorTime: '21:00',
        appliesFromTime: '21:00',
        appliesToTime: '07:00',
      }),
      '2026-07-27',
      MELBOURNE,
    );
    const last = windows[windows.length - 1]!;
    expect(last.endMinutes - last.startMinutes).toBe(120);
  });

  /**
   * The alternative was to skip the part-window at the start, which would leave
   * an hour nobody is asked to record anything in. Clipping keeps the timeline
   * whole and the admin gets a warning about the short window instead.
   */
  it('clips the first window when the anchor does not line up', () => {
    const windows = generateSegmentWindows(
      segment({ anchorTime: '06:00', appliesFromTime: '07:00', appliesToTime: '13:00' }),
      '2026-07-27',
      MELBOURNE,
    );
    expect(ranges(windows)).toEqual(['07:00–08:00', '08:00–10:00', '10:00–12:00', '12:00–13:00']);
  });

  it('skips a day the segment does not apply to', () => {
    // 2026-07-26 is a Sunday.
    const weekdaysOnly = segment({ weekdays: [1, 2, 3, 4, 5] });
    expect(generateSegmentWindows(weekdaysOnly, '2026-07-26', MELBOURNE)).toHaveLength(0);
    expect(generateSegmentWindows(weekdaysOnly, '2026-07-27', MELBOURNE)).toHaveLength(7);
  });

  it('merges several segments into one ordered day', () => {
    const windows = generateDayWindows(
      [
        segment(),
        segment({
          windowMinutes: 240,
          anchorTime: '21:00',
          appliesFromTime: '21:00',
          appliesToTime: '07:00',
          sortOrder: 1,
        }),
      ],
      '2026-07-27',
      MELBOURNE,
    );
    expect(ranges(windows)).toEqual([
      '07:00–09:00',
      '09:00–11:00',
      '11:00–13:00',
      '13:00–15:00',
      '15:00–17:00',
      '17:00–19:00',
      '19:00–21:00',
      '21:00–01:00',
      '01:00–05:00',
      '05:00–07:00',
    ]);
  });

  /**
   * The grid is a local clock grid, so a window that spans the change is an
   * hour shorter or longer in real time. Staff read 01:00 to 05:00 either way,
   * which is the point.
   */
  it('keeps local clock times over a daylight saving change', () => {
    const overnight = segment({
      windowMinutes: 240,
      anchorTime: '21:00',
      appliesFromTime: '21:00',
      appliesToTime: '07:00',
    });
    const windows = generateSegmentWindows(overnight, '2026-10-03', MELBOURNE);
    expect(ranges(windows)).toEqual(['21:00–01:00', '01:00–05:00', '05:00–07:00']);

    const middle = windows[1]!;
    const realMinutes = (middle.endsAt.getTime() - middle.startsAt.getTime()) / 60_000;
    expect(realMinutes).toBe(180);
  });
});

describe('segment week intervals', () => {
  it('covers the whole week when a segment runs all day every day', () => {
    const allDay = segment({ appliesFromTime: '00:00', appliesToTime: '24:00' });
    expect(totalLength(segmentWeekIntervals(allDay))).toBe(10_080);
  });

  it('wraps an overnight segment past the end of the week', () => {
    const saturdayNight = segment({
      appliesFromTime: '21:00',
      appliesToTime: '07:00',
      weekdays: [6],
    });
    const intervals = segmentWeekIntervals(saturdayNight);
    expect(totalLength(intervals)).toBe(600);
    // Part of it lands back at the start of the week, on Sunday morning.
    expect(intervals.some((one) => one.start === 0)).toBe(true);
  });
});

describe('validation', () => {
  it('accepts the day and night pair from the docs', () => {
    const result = validateSegments([
      segment(),
      segment({
        windowMinutes: 240,
        anchorTime: '21:00',
        appliesFromTime: '21:00',
        appliesToTime: '07:00',
      }),
    ]);
    expect(result.problems).toEqual([]);
    expect(result.warnings.map((one) => one.code)).toEqual(['uneven_division']);
  });

  it('refuses overlapping segments', () => {
    const result = validateSegments([
      segment({ appliesFromTime: '07:00', appliesToTime: '15:00' }),
      segment({ appliesFromTime: '13:00', appliesToTime: '21:00', anchorTime: '13:00' }),
    ]);
    expect(result.problems.map((one) => one.code)).toEqual(['overlap']);
    expect(result.problems[0]?.segments).toEqual([0, 1]);
  });

  it('allows two segments that only share a boundary', () => {
    const result = validateSegments([
      segment({ appliesFromTime: '07:00', appliesToTime: '13:00' }),
      segment({ appliesFromTime: '13:00', appliesToTime: '21:00', anchorTime: '13:00' }),
    ]);
    expect(result.problems).toEqual([]);
  });

  it('allows the same hours on different days', () => {
    const result = validateSegments([
      segment({ weekdays: [1, 2, 3, 4, 5] }),
      segment({ weekdays: [0, 6] }),
    ]);
    expect(result.problems).toEqual([]);
  });

  it('warns about a gap rather than refusing it', () => {
    const result = validateSegments([segment()]);
    const gap = result.warnings.find((one) => one.code === 'gap');
    expect(gap).toBeDefined();
    // 10 uncovered hours a day, every day.
    expect(gap?.message).toContain('70 hours');
  });

  it('warns when the window does not divide the segment evenly', () => {
    const result = validateSegments([
      segment({ appliesFromTime: '07:00', appliesToTime: '20:00' }),
    ]);
    expect(result.warnings.some((one) => one.code === 'uneven_division')).toBe(true);
  });

  it('warns when the anchor does not land on the segment start', () => {
    const result = validateSegments([segment({ anchorTime: '06:30' })]);
    expect(result.warnings.some((one) => one.code === 'anchor_misaligned')).toBe(true);
  });

  it('warns when the anchor is after the segment start', () => {
    const result = validateSegments([segment({ anchorTime: '09:00' })]);
    expect(result.warnings.some((one) => one.code === 'anchor_after_start')).toBe(true);
  });

  it('does not report a gap when segments already clash', () => {
    const result = validateSegments([
      segment({ appliesFromTime: '00:00', appliesToTime: '24:00' }),
      segment({ appliesFromTime: '07:00', appliesToTime: '09:00' }),
    ]);
    expect(result.problems).toHaveLength(1);
    expect(result.warnings.some((one) => one.code === 'gap')).toBe(false);
  });
});

describe('descriptions', () => {
  it('reads the way the schedule editor shows it', () => {
    expect(describeSegment(segment())).toBe('Every 2 hours, starting 07:00');
    expect(describeSegment(segment({ windowMinutes: 60 }))).toBe('Every 1 hour, starting 07:00');
    expect(describeSegment(segment({ windowMinutes: 90 }))).toBe(
      'Every 90 minutes, starting 07:00',
    );
  });

  it('names weekday sets', () => {
    expect(describeWeekdays(null)).toBe('Every day');
    expect(describeWeekdays([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(describeWeekdays([0, 6])).toBe('Weekends');
    expect(describeWeekdays([1, 3])).toBe('Mon, Wed');
  });
});
