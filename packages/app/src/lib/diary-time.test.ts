import { describe, expect, it } from 'vitest';
import { formatTimeOfDay, parseTimeOfDay, utcToZoned, zonedTimeToUtc } from '@vigilo/shared';
import { formatDateTimeIn } from './format';

/**
 * When a diary entry happened (doc 06 §4.5, doc 06 §7).
 *
 * `<input type="datetime-local">` gives a wall clock with no zone attached, so
 * something has to decide which zone it belongs to. The device's is the wrong
 * answer: the org timezone is the only one staff ever see, and the same entry
 * showing 17:27 on one tab and 19:27 on another is how that goes wrong.
 *
 * The functions here are duplicated from DiaryEntryForm because they live in a
 * `<script setup>` block. If that changes, this changes with it.
 */
const MELBOURNE = 'Australia/Melbourne';

function toInput(iso: string, timeZone: string): string {
  const zoned = utcToZoned(new Date(iso), timeZone);
  return `${zoned.date}T${formatTimeOfDay(zoned.minutes)}`;
}

function fromInput(value: string, timeZone: string): Date | null {
  const [date, time] = value.split('T');
  if (!date || !time) return null;
  try {
    return zonedTimeToUtc(date, parseTimeOfDay(time.slice(0, 5)), timeZone);
  } catch {
    return null;
  }
}

describe('the occurred-at input', () => {
  it('shows an instant at the hour it happened in the org timezone', () => {
    // 09:27 UTC is 19:27 in Melbourne, whatever the device thinks.
    expect(toInput('2026-07-28T09:27:00Z', MELBOURNE)).toBe('2026-07-28T19:27');
    expect(toInput('2026-07-28T09:27:00Z', 'UTC')).toBe('2026-07-28T09:27');
  });

  it('reads a typed wall clock as that hour in the org timezone', () => {
    expect(fromInput('2026-07-28T19:27', MELBOURNE)?.toISOString()).toBe(
      '2026-07-28T09:27:00.000Z',
    );
  });

  it('round-trips', () => {
    const iso = '2026-07-28T09:27:00.000Z';
    expect(fromInput(toInput(iso, MELBOURNE), MELBOURNE)?.toISOString()).toBe(iso);
  });

  /** Melbourne is +11 in January and +10 in July. */
  it('round-trips across a daylight saving change', () => {
    for (const iso of ['2026-01-15T09:27:00.000Z', '2026-07-15T09:27:00.000Z']) {
      expect(fromInput(toInput(iso, MELBOURNE), MELBOURNE)?.toISOString()).toBe(iso);
    }
  });

  it('returns null for an empty or half-typed value rather than an invalid date', () => {
    expect(fromInput('', MELBOURNE)).toBeNull();
    expect(fromInput('2026-07-28', MELBOURNE)).toBeNull();
  });
});

describe('formatDateTimeIn', () => {
  it('renders in the org timezone, not the device one', () => {
    const melbourne = formatDateTimeIn('2026-07-28T09:27:00Z', MELBOURNE);
    const utc = formatDateTimeIn('2026-07-28T09:27:00Z', 'UTC');

    expect(melbourne).toContain('07:27 pm');
    expect(utc).toContain('09:27 am');
  });

  it('hands back anything unparseable rather than showing "Invalid Date"', () => {
    expect(formatDateTimeIn('not a date', MELBOURNE)).toBe('not a date');
  });
});
