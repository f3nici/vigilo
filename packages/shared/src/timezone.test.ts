import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatTimeOfDay,
  isIsoDate,
  isTimeOfDay,
  localDateOf,
  parseTimeOfDay,
  utcToZoned,
  weekdayOf,
  zonedTimeToUtc,
} from './timezone.js';

const MELBOURNE = 'Australia/Melbourne';

describe('times of day', () => {
  it('accepts a clock time and 24:00 for the end of a day', () => {
    expect(isTimeOfDay('07:00')).toBe(true);
    expect(isTimeOfDay('23:59')).toBe(true);
    expect(isTimeOfDay('24:00')).toBe(true);
    expect(isTimeOfDay('24:01')).toBe(false);
    expect(isTimeOfDay('7:00')).toBe(false);
    expect(isTimeOfDay('25:00')).toBe(false);
  });

  it('round trips', () => {
    expect(parseTimeOfDay('07:30')).toBe(450);
    expect(parseTimeOfDay('24:00')).toBe(1440);
    expect(formatTimeOfDay(450)).toBe('07:30');
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(1440)).toBe('24:00');
  });

  it('formats minutes past midnight as the next day', () => {
    expect(formatTimeOfDay(1500)).toBe('01:00');
  });
});

describe('dates', () => {
  it('validates', () => {
    expect(isIsoDate('2026-07-27')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('27/07/2026')).toBe(false);
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-07-27', '2026-08-03')).toBe(7);
  });

  it('counts Sunday as 0', () => {
    expect(weekdayOf('2026-07-26')).toBe(0);
    expect(weekdayOf('2026-07-27')).toBe(1);
  });
});

describe('zone conversion', () => {
  it('converts a Melbourne wall clock to UTC in winter', () => {
    // AEST, UTC+10.
    expect(zonedTimeToUtc('2026-07-27', 7 * 60, MELBOURNE).toISOString()).toBe(
      '2026-07-26T21:00:00.000Z',
    );
  });

  it('converts a Melbourne wall clock to UTC in summer', () => {
    // AEDT, UTC+11.
    expect(zonedTimeToUtc('2026-01-15', 7 * 60, MELBOURNE).toISOString()).toBe(
      '2026-01-14T20:00:00.000Z',
    );
  });

  it('handles minutes past midnight as the following morning', () => {
    // 21:00 plus a 4 hour overnight window lands at 01:00 the next day.
    expect(zonedTimeToUtc('2026-07-27', 25 * 60, MELBOURNE).toISOString()).toBe(
      '2026-07-27T15:00:00.000Z',
    );
  });

  it('reads an instant back as the same wall clock', () => {
    const instant = zonedTimeToUtc('2026-07-27', 9 * 60 + 30, MELBOURNE);
    const parts = utcToZoned(instant, MELBOURNE);
    expect(parts.date).toBe('2026-07-27');
    expect(parts.minutes).toBe(9 * 60 + 30);
    expect(parts.weekday).toBe(1);
  });

  /**
   * The two days a year the arithmetic could go wrong. Melbourne moves the
   * clock forward at 02:00 on the first Sunday in October and back at 03:00 on
   * the first Sunday in April.
   */
  it('keeps wall clock times correct on the day the clocks go forward', () => {
    // 2026-10-04, 02:00 becomes 03:00.
    expect(zonedTimeToUtc('2026-10-04', 1 * 60, MELBOURNE).toISOString()).toBe(
      '2026-10-03T15:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-10-04', 4 * 60, MELBOURNE).toISOString()).toBe(
      '2026-10-03T17:00:00.000Z',
    );
  });

  it('resolves a local time that does not exist to the instant the clock jumps to', () => {
    // 02:30 never happens on 2026-10-04. It must not throw and must not land
    // before 02:00, which would put a window out of order.
    const skipped = zonedTimeToUtc('2026-10-04', 2 * 60 + 30, MELBOURNE);
    expect(utcToZoned(skipped, MELBOURNE).minutes).toBe(3 * 60 + 30);
  });

  it('keeps wall clock times correct on the day the clocks go back', () => {
    // 2026-04-05, 03:00 becomes 02:00. 01:00 is AEDT (+11), 04:00 is AEST (+10).
    expect(zonedTimeToUtc('2026-04-05', 1 * 60, MELBOURNE).toISOString()).toBe(
      '2026-04-04T14:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-04-05', 4 * 60, MELBOURNE).toISOString()).toBe(
      '2026-04-04T18:00:00.000Z',
    );
  });

  it('gives the local date, which is what "today" means to staff', () => {
    // 22:00 UTC is already tomorrow in Melbourne.
    expect(localDateOf(new Date('2026-07-26T22:00:00Z'), MELBOURNE)).toBe('2026-07-27');
    expect(localDateOf(new Date('2026-07-26T22:00:00Z'), 'UTC')).toBe('2026-07-26');
  });
});
