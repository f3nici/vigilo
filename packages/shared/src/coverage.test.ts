import { describe, expect, it } from 'vitest';
import {
  coverageRangeSchema,
  describeCoverageDecision,
  endOfDayMinutes,
  resolveCoverage,
  type CoverageExceptionRow,
  type CoverageRangeRow,
} from './coverage.js';
import { zonedTimeToUtc } from './timezone.js';

const MELBOURNE = 'Australia/Melbourne';

function window(date: string, fromMinutes: number, toMinutes: number) {
  return {
    startsAt: zonedTimeToUtc(date, fromMinutes, MELBOURNE),
    endsAt: zonedTimeToUtc(date, toMinutes, MELBOURNE),
  };
}

function range(weekday: number, startTime: string, endTime: string): CoverageRangeRow {
  return { weekday, startTime, endTime, activeFrom: '2020-01-01', activeTo: null };
}

function exception(
  startsAt: Date,
  endsAt: Date,
  effect: 'covered' | 'not_covered',
  createdAt: string,
  reason = 'Because',
): CoverageExceptionRow {
  return { startsAt, endsAt, effect, reason, createdAt: new Date(createdAt) };
}

/** Monday to Friday 07:00 to 19:00, Saturday 09:00 to 17:00, Sunday nothing. */
const WEEKLY: CoverageRangeRow[] = [
  range(1, '07:00', '19:00'),
  range(2, '07:00', '19:00'),
  range(3, '07:00', '19:00'),
  range(4, '07:00', '19:00'),
  range(5, '07:00', '19:00'),
  range(6, '09:00', '17:00'),
];

describe('coverage', () => {
  it('expects a window inside supported hours', () => {
    // Monday 09:00-11:00.
    const decision = resolveCoverage(window('2026-07-27', 540, 660), WEEKLY, [], MELBOURNE);
    expect(decision).toEqual({ expected: true, reason: 'covered', exceptionReason: null });
  });

  it('does not expect a window on an uncovered day', () => {
    // Sunday 09:00-11:00.
    const decision = resolveCoverage(window('2026-07-26', 540, 660), WEEKLY, [], MELBOURNE);
    expect(decision.expected).toBe(false);
    expect(decision.reason).toBe('outside_supported_hours');
  });

  it('does not expect a window outside the covered hours of a covered day', () => {
    // Monday 21:00-23:00, after support ends at 19:00.
    const decision = resolveCoverage(window('2026-07-27', 1260, 1380), WEEKLY, [], MELBOURNE);
    expect(decision.expected).toBe(false);
  });

  /**
   * Doc 10 Q5, taking the suggested default. Support ends at 19:00 and the
   * window runs 18:00 to 20:00: someone is there for the first hour, so the
   * check could have been recorded and not expecting it would hide that.
   */
  it('expects a window that is only partly covered', () => {
    const decision = resolveCoverage(window('2026-07-27', 1080, 1200), WEEKLY, [], MELBOURNE);
    expect(decision.expected).toBe(true);
  });

  it('does not expect a window that only touches the boundary', () => {
    // 19:00-21:00 starts exactly as support ends. Half-open, so no overlap.
    const decision = resolveCoverage(window('2026-07-27', 1140, 1260), WEEKLY, [], MELBOURNE);
    expect(decision.expected).toBe(false);
  });

  /**
   * A participant whose coverage has not been set up yet still gets expected
   * windows. The other reading would produce a silent week of not-expected.
   */
  it('treats no pattern at all as always covered', () => {
    const decision = resolveCoverage(window('2026-07-26', 180, 300), [], [], MELBOURNE);
    expect(decision.expected).toBe(true);
  });

  it('honours the dates a pattern applied between', () => {
    const oldPattern: CoverageRangeRow[] = [
      {
        weekday: 0,
        startTime: '07:00',
        endTime: '19:00',
        activeFrom: '2026-01-01',
        activeTo: '2026-07-01',
      },
    ];
    // Sunday, after the pattern was superseded.
    const decision = resolveCoverage(window('2026-07-26', 540, 660), oldPattern, [], MELBOURNE);
    expect(decision.expected).toBe(false);
  });
});

describe('coverage exceptions', () => {
  it('adds coverage where the pattern has none', () => {
    // A one-off Sunday shift.
    const sunday = window('2026-07-26', 540, 660);
    const decision = resolveCoverage(
      sunday,
      WEEKLY,
      [
        exception(
          zonedTimeToUtc('2026-07-26', 480, MELBOURNE),
          zonedTimeToUtc('2026-07-26', 960, MELBOURNE),
          'covered',
          '2026-07-20T00:00:00Z',
          'Extra shift booked',
        ),
      ],
      MELBOURNE,
    );
    expect(decision.expected).toBe(true);
  });

  it('removes coverage the pattern would give', () => {
    const monday = window('2026-07-27', 540, 660);
    const decision = resolveCoverage(
      monday,
      WEEKLY,
      [
        exception(
          zonedTimeToUtc('2026-07-27', 0, MELBOURNE),
          zonedTimeToUtc('2026-07-28', 0, MELBOURNE),
          'not_covered',
          '2026-07-20T00:00:00Z',
          'Family holiday',
        ),
      ],
      MELBOURNE,
    );
    expect(decision.expected).toBe(false);
    expect(decision.reason).toBe('exception');
    expect(decision.exceptionReason).toBe('Family holiday');
  });

  it('lets the most recently created exception win', () => {
    const monday = window('2026-07-27', 540, 660);
    const span: [Date, Date] = [
      zonedTimeToUtc('2026-07-27', 0, MELBOURNE),
      zonedTimeToUtc('2026-07-28', 0, MELBOURNE),
    ];

    const decision = resolveCoverage(
      monday,
      WEEKLY,
      [
        exception(span[0], span[1], 'not_covered', '2026-07-20T00:00:00Z', 'Holiday'),
        exception(span[0], span[1], 'covered', '2026-07-25T00:00:00Z', 'Holiday cancelled'),
      ],
      MELBOURNE,
    );
    expect(decision.expected).toBe(true);
  });

  it('does not care what order the rows arrive in', () => {
    const monday = window('2026-07-27', 540, 660);
    const span: [Date, Date] = [
      zonedTimeToUtc('2026-07-27', 0, MELBOURNE),
      zonedTimeToUtc('2026-07-28', 0, MELBOURNE),
    ];
    const later = exception(span[0], span[1], 'not_covered', '2026-07-25T00:00:00Z', 'Admitted');
    const earlier = exception(span[0], span[1], 'covered', '2026-07-20T00:00:00Z', 'Extra');

    expect(resolveCoverage(monday, WEEKLY, [later, earlier], MELBOURNE).expected).toBe(false);
    expect(resolveCoverage(monday, WEEKLY, [earlier, later], MELBOURNE).expected).toBe(false);
  });

  it('only removes the part of a window an exception covers', () => {
    // Monday 09:00-11:00, with 09:00-10:00 removed. An hour is still supported.
    const decision = resolveCoverage(
      window('2026-07-27', 540, 660),
      WEEKLY,
      [
        exception(
          zonedTimeToUtc('2026-07-27', 540, MELBOURNE),
          zonedTimeToUtc('2026-07-27', 600, MELBOURNE),
          'not_covered',
          '2026-07-20T00:00:00Z',
        ),
      ],
      MELBOURNE,
    );
    expect(decision.expected).toBe(true);
  });
});

describe('descriptions', () => {
  it('says why a window is greyed out', () => {
    expect(
      describeCoverageDecision({
        expected: false,
        reason: 'exception',
        exceptionReason: 'In hospital',
      }),
    ).toBe('In hospital');
    expect(
      describeCoverageDecision({
        expected: false,
        reason: 'outside_supported_hours',
        exceptionReason: null,
      }),
    ).toBe('Outside supported hours');
  });
});

/**
 * `<input type="time">` refuses `24:00` outright and renders an empty box, so
 * the picker an admin actually uses can only produce `00:00` for midnight. Both
 * spellings have to mean the same instant or the UI cannot express a range that
 * runs to the end of the day.
 */
describe('midnight', () => {
  it('reads 00:00 and 24:00 as the same end of day', () => {
    for (const endTime of ['24:00', '00:00']) {
      const overnight: CoverageRangeRow[] = [
        { weekday: 1, startTime: '19:00', endTime, activeFrom: '2020-01-01', activeTo: null },
      ];
      // Monday 22:00-23:00, inside a range running to midnight.
      const decision = resolveCoverage(window('2026-07-27', 1320, 1380), overnight, [], MELBOURNE);
      expect(decision.expected, endTime).toBe(true);
    }
  });

  it('accepts a range ending at midnight either way', () => {
    for (const endTime of ['24:00', '00:00']) {
      const parsed = coverageRangeSchema.safeParse({ weekday: 1, startTime: '19:00', endTime });
      expect(parsed.success, endTime).toBe(true);
    }
  });

  it('still refuses a range that ends before it starts', () => {
    expect(
      coverageRangeSchema.safeParse({ weekday: 1, startTime: '19:00', endTime: '07:00' }).success,
    ).toBe(false);
  });

  it('measures the end of day as 1440 minutes', () => {
    expect(endOfDayMinutes('00:00')).toBe(1440);
    expect(endOfDayMinutes('24:00')).toBe(1440);
    expect(endOfDayMinutes('19:00')).toBe(1140);
  });
});
