import { describe, expect, it } from 'vitest';
import { addMonths, isSameMonth, monthGrid, monthGridRange, startOfMonth } from './calendar.js';

describe('startOfMonth', () => {
  it('keeps the month and drops the day', () => {
    expect(startOfMonth('2026-08-19')).toBe('2026-08-01');
    expect(startOfMonth('2026-08-01')).toBe('2026-08-01');
  });
});

describe('addMonths', () => {
  it('walks forwards and backwards', () => {
    expect(addMonths('2026-08-01', 1)).toBe('2026-09-01');
    expect(addMonths('2026-08-01', -1)).toBe('2026-07-01');
  });

  it('crosses the year in both directions', () => {
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-01');
  });

  /** Day-of-month arithmetic would land on 31 February. This never carries one. */
  it('always lands on the first', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
  });
});

describe('monthGrid', () => {
  it('starts on the Monday on or before the first', () => {
    // 1 August 2026 is a Saturday, so the grid opens on Monday 27 July.
    expect(monthGrid('2026-08-14')[0]![0]).toBe('2026-07-27');
  });

  it('is always six weeks of seven days', () => {
    for (const date of ['2026-02-10', '2026-08-14', '2027-01-01', '2024-02-05']) {
      const weeks = monthGrid(date);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
    }
  });

  it('runs consecutively with no gap or repeat', () => {
    const days = monthGrid('2026-08-14').flat();
    expect(new Set(days).size).toBe(42);
    for (let i = 1; i < days.length; i += 1) {
      const gap = Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`);
      expect(gap).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('holds every day of the month it is for', () => {
    const days = new Set(monthGrid('2026-02-10').flat());
    for (let day = 1; day <= 28; day += 1) {
      expect(days.has(`2026-02-${String(day).padStart(2, '0')}`)).toBe(true);
    }
  });

  /** A February starting on a Monday is the tight case: 28 days, exactly four weeks. */
  it('still gives six weeks when the month fits in four', () => {
    const weeks = monthGrid('2021-02-10');
    expect(weeks[0]![0]).toBe('2021-02-01');
    expect(weeks).toHaveLength(6);
  });
});

describe('monthGridRange', () => {
  it('covers the whole grid, not just the month', () => {
    expect(monthGridRange('2026-08-14')).toEqual({ from: '2026-07-27', to: '2026-09-06' });
  });
});

describe('isSameMonth', () => {
  it('compares the month, not the day', () => {
    expect(isSameMonth('2026-08-01', '2026-08-31')).toBe(true);
    expect(isSameMonth('2026-08-31', '2026-09-01')).toBe(false);
    expect(isSameMonth('2025-08-01', '2026-08-01')).toBe(false);
  });
});
