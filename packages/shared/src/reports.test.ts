import { describe, expect, it } from 'vitest';
import {
  completionPercent,
  countCompliance,
  csvField,
  csvRow,
  emptyCounts,
  findGaps,
  rangeTooLong,
  summarise,
  unexplainedPercent,
  type ComplianceWindow,
} from './reports.js';

function window(overrides: Partial<ComplianceWindow>): ComplianceWindow {
  return { status: 'complete', isLate: false, hasMissReason: false, ...overrides };
}

describe('compliance counting', () => {
  it('counts nothing as nothing', () => {
    expect(countCompliance([])).toEqual(emptyCounts());
  });

  it('leaves not-expected windows out of the denominator and shows them separately', () => {
    // Doc 01 §5.6. A weekend the family covered is not a check the team missed,
    // and folding it into the percentage would make a well-run week look bad.
    const counts = countCompliance([
      window({ status: 'complete' }),
      window({ status: 'not_expected' }),
      window({ status: 'not_expected' }),
    ]);

    expect(counts.expected).toBe(1);
    expect(counts.notExpected).toBe(2);
    expect(completionPercent(counts)).toBe(100);
  });

  it('counts a late completion as completed, and as late', () => {
    // Late is a fact about the record, not a failure to record. The window was
    // checked, so it is completed; the lateness is its own column.
    const counts = countCompliance([window({ status: 'complete', isLate: true })]);

    expect(counts.completed).toBe(1);
    expect(counts.completedLate).toBe(1);
    expect(completionPercent(counts)).toBe(100);
  });

  it('splits missed windows by whether anybody explained them', () => {
    const counts = countCompliance([
      window({ status: 'missed', hasMissReason: true }),
      window({ status: 'missed', hasMissReason: false }),
      window({ status: 'missed', hasMissReason: false }),
    ]);

    expect(counts.missed).toBe(3);
    expect(counts.missedWithReason).toBe(1);
    expect(counts.missedWithoutReason).toBe(2);
    expect(unexplainedPercent(counts)).toBe(67);
  });

  it('does not count a part-filled entry as a completed check', () => {
    // Somebody reading this number is asking whether the check was done, and
    // half a set of observations is not a check that was done.
    const counts = countCompliance([window({ status: 'partial' }), window({ status: 'complete' })]);

    expect(counts.partial).toBe(1);
    expect(counts.completed).toBe(1);
    expect(completionPercent(counts)).toBe(50);
  });

  it('counts a window still open as expected but not yet anything else', () => {
    const counts = countCompliance([window({ status: 'pending' })]);
    expect(counts.expected).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.completed).toBe(0);
  });

  it('has no percentage when nothing was expected', () => {
    // Not 100 and not 0. A week with no scheduled checks has no compliance
    // figure, and printing one would be a claim nobody made.
    const counts = countCompliance([window({ status: 'not_expected' })]);
    expect(completionPercent(counts)).toBeNull();
    expect(unexplainedPercent(counts)).toBeNull();
  });

  it('matches a hand-counted week', () => {
    // The roadmap's phase gate: the numbers have to match what a person gets
    // counting the same windows on paper.
    //
    // 14 windows: 9 complete (2 of them late), 1 partial, 3 missed (2 with a
    // reason), 1 not expected. So 13 expected, 9 completed, 69 percent.
    const windows: ComplianceWindow[] = [
      ...Array.from({ length: 7 }, () => window({ status: 'complete' })),
      window({ status: 'complete', isLate: true }),
      window({ status: 'complete', isLate: true }),
      window({ status: 'partial' }),
      window({ status: 'missed', hasMissReason: true }),
      window({ status: 'missed', hasMissReason: true }),
      window({ status: 'missed', hasMissReason: false }),
      window({ status: 'not_expected' }),
    ];

    const counts = countCompliance(windows);

    expect(counts).toEqual({
      expected: 13,
      completed: 9,
      completedLate: 2,
      partial: 1,
      pending: 0,
      missed: 3,
      missedWithReason: 2,
      missedWithoutReason: 1,
      notExpected: 1,
      unscheduled: 0,
    });
    expect(completionPercent(counts)).toBe(69);
  });
});

describe('trend gaps', () => {
  const at = (hours: number) => ({ at: new Date(Date.UTC(2026, 6, 29, hours)).toISOString() });

  it('finds nothing in a regular series', () => {
    expect(findGaps([at(0), at(2), at(4), at(6)])).toEqual([]);
  });

  it('leaves an overnight break alone', () => {
    // A 4-hourly overnight interval is the schedule working, not a hole in it.
    expect(findGaps([at(21), at(1 + 24)])).toEqual([]);
  });

  it('reports a real hole with its size', () => {
    const gaps = findGaps([at(0), at(20)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.hours).toBe(20);
  });

  it('never interpolates across one', () => {
    // The whole point: the series keeps its two points and says there is
    // nothing between them, rather than drawing a line that claims otherwise.
    const points = [at(0), at(20), at(22)];
    const gaps = findGaps(points);
    expect(points).toHaveLength(3);
    expect(gaps).toHaveLength(1);
  });

  it('finds nothing in an empty or single-point series', () => {
    expect(findGaps([])).toEqual([]);
    expect(findGaps([at(0)])).toEqual([]);
  });
});

describe('trend summary', () => {
  it('is empty for no points', () => {
    expect(summarise([])).toEqual({ min: null, max: null, mean: null });
  });

  it('reports the range and the mean without inventing precision', () => {
    const summary = summarise([
      { at: 'a', value: 100, samples: 1 },
      { at: 'b', value: 150, samples: 1 },
      { at: 'c', value: 175, samples: 1 },
    ]);
    expect(summary).toEqual({ min: 100, max: 175, mean: 141.67 });
  });
});

describe('range limits', () => {
  it('allows a month', () => {
    expect(rangeTooLong('2026-07-01', '2026-07-31')).toBe(false);
  });

  it('allows exactly a year', () => {
    expect(rangeTooLong('2026-01-01', '2026-12-31')).toBe(false);
  });

  it('refuses a decade rather than timing out on it', () => {
    expect(rangeTooLong('2016-01-01', '2026-01-01')).toBe(true);
  });
});

describe('csv fields', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('cpap')).toBe('cpap');
    expect(csvField(325)).toBe('325');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    expect(csvField('Smith, Aroha')).toBe('"Smith, Aroha"');
    expect(csvField('she said "no"')).toBe('"she said ""no"""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('defuses a value a spreadsheet would run as a formula', () => {
    // A diary note starting with = would execute when an auditor opens the
    // file. This export is handed to outsiders, so it is a real attack.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('+44 7700 900000')).toBe("'+44 7700 900000");
  });

  it('quotes a value with leading or trailing space rather than losing it', () => {
    expect(csvField(' 325 ')).toBe('" 325 "');
  });

  it('writes an empty cell for nothing', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('ends a row the way a spreadsheet expects', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('checks nobody scheduled', () => {
  /**
   * D89. The percentage is the one number somebody will be asked to defend, so
   * an unscheduled check has to stay outside it in both directions.
   */
  it('is counted, and changes neither the denominator nor the percentage', () => {
    const windows: ComplianceWindow[] = [
      window({ status: 'complete' }),
      window({ status: 'complete' }),
      window({ status: 'missed', hasMissReason: false }),
    ];

    const without = countCompliance(windows);
    const with5 = countCompliance(windows, 5);

    expect(with5.unscheduled).toBe(5);
    expect(with5.expected).toBe(without.expected);
    expect(with5.completed).toBe(without.completed);
    expect(completionPercent(with5)).toBe(completionPercent(without));
  });

  it('cannot push the figure above 100 percent', () => {
    // Counting these as completed would do exactly that, which is why they are
    // a separate number rather than part of the numerator.
    const counts = countCompliance([window({ status: 'complete' })], 20);
    expect(completionPercent(counts)).toBe(100);
  });

  it('cannot hide a missed scheduled check behind an unscheduled one', () => {
    const counts = countCompliance([window({ status: 'missed', hasMissReason: false })], 3);
    expect(counts.missedWithoutReason).toBe(1);
    expect(completionPercent(counts)).toBe(0);
  });

  it('shows on its own for a participant with nothing scheduled at all', () => {
    const counts = countCompliance([], 2);
    expect(counts.unscheduled).toBe(2);
    expect(counts.expected).toBe(0);
  });
});
