import { describe, expect, it } from 'vitest';
import { canSyncOffline, isSelfAccess, type Role } from './roles.js';
import {
  dayIsEmpty,
  describeMyCheck,
  emptyDayMessage,
  myDaySchema,
  myDayTimeline,
  myRecordsQuerySchema,
  myDayQuerySchema,
  participantSeesWindow,
  recordCount,
  type MyCheck,
  type MyDay,
} from './selfaccess.js';
import { windowStatuses } from './windows.js';

const staff: Role[] = ['admin', 'team_leader', 'nurse', 'worker'];

const ID = '01952d3f-0000-7000-8000-000000000001';

describe('which checks a participant sees', () => {
  it('shows the ones that hold a record', () => {
    expect(participantSeesWindow('complete')).toBe(true);
    expect(participantSeesWindow('partial')).toBe(true);
  });

  it('never shows a missed, pending or not-expected check', () => {
    // Doc 06 §6: these are about whether staff did what the schedule asked.
    expect(participantSeesWindow('missed')).toBe(false);
    expect(participantSeesWindow('pending')).toBe(false);
    expect(participantSeesWindow('not_expected')).toBe(false);
  });

  it('has an answer for every status, so a new one is not silently shown', () => {
    for (const status of windowStatuses) {
      expect(typeof participantSeesWindow(status)).toBe('boolean');
    }
  });
});

describe('who syncs', () => {
  it('gives every staff role offline records', () => {
    for (const role of staff) expect(canSyncOffline(role)).toBe(true);
  });

  it('never puts records on a self-access device', () => {
    expect(canSyncOffline('participant')).toBe(false);
    expect(isSelfAccess('participant')).toBe(true);
    for (const role of staff) expect(isSelfAccess(role)).toBe(false);
  });
});

describe('the queries', () => {
  it('treats a missing date as today, decided by the server', () => {
    expect(myDayQuerySchema.parse({})).toEqual({});
  });

  it('refuses anything but a date', () => {
    expect(myDayQuerySchema.safeParse({ date: 'yesterday' }).success).toBe(false);
    // Strict, so a participant id in the query string is a parse failure
    // rather than something the service has to remember to ignore.
    expect(myDayQuerySchema.safeParse({ participantId: 'x' }).success).toBe(false);
    expect(
      myRecordsQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-02', participantId: 'x' })
        .success,
    ).toBe(false);
  });

  it('refuses a range that runs backwards', () => {
    expect(myRecordsQuerySchema.safeParse({ from: '2026-03-05', to: '2026-03-01' }).success).toBe(
      false,
    );
    expect(myRecordsQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-01' }).success).toBe(
      true,
    );
  });
});

describe('a day', () => {
  const check: MyCheck = {
    id: ID,
    recordedAt: '2026-03-02T09:12:00Z',
    templateName: 'Morning check',
    recordedByName: 'Sam Okafor',
    values: [{ fieldKey: 'mood', label: 'Mood', display: 'Settled' }],
  };

  const day: MyDay = { date: '2026-03-02', checks: [check], diary: [] };

  it('carries only the fields doc 06 §6 allows', () => {
    const parsed = myDaySchema.parse(day);
    expect(Object.keys(parsed.checks[0]!).sort()).toEqual([
      'id',
      'recordedAt',
      'recordedByName',
      'templateName',
      'values',
    ]);
  });

  it('drops a status or a lateness somebody adds to the payload', () => {
    // Zod strips unknown keys, so a service that accidentally spread a staff
    // window into this shape still cannot publish one.
    const parsed = myDaySchema.parse({
      ...day,
      checks: [{ ...check, status: 'missed', isLate: true, editCount: 3 }],
    });
    expect(parsed.checks[0]).not.toHaveProperty('status');
    expect(parsed.checks[0]).not.toHaveProperty('isLate');
    expect(parsed.checks[0]).not.toHaveProperty('editCount');
  });

  it('keeps the photos on an entry and drops the flag that decided it', () => {
    const parsed = myDaySchema.parse({
      date: '2026-03-02',
      checks: [],
      diary: [
        {
          id: ID,
          occurredAt: '2026-03-02T14:00:00Z',
          categoryLabel: 'Activity',
          body: 'Went to the market.',
          recordedByName: 'Sam Okafor',
          photos: [{ id: ID, isImage: true }],
          edited: false,
          // The staff DTO carries this. It is how the entry got here at all,
          // and it is not a thing to hand to the person it was decided about.
          visibleToParticipant: true,
        },
      ],
    });

    expect(parsed.diary[0]?.photos).toEqual([{ id: ID, isImage: true }]);
    expect(parsed.diary[0]).not.toHaveProperty('visibleToParticipant');
  });

  it('counts what is on it', () => {
    expect(recordCount(day)).toBe(1);
    expect(dayIsEmpty(day)).toBe(false);
    expect(dayIsEmpty({ date: '2026-03-02', checks: [], diary: [] })).toBe(true);
  });

  it('names who recorded it, and copes when nobody is named', () => {
    expect(describeMyCheck(check)).toBe('Morning check by Sam Okafor');
    expect(describeMyCheck({ ...check, recordedByName: null })).toBe('Morning check');
  });
});

describe('an empty day', () => {
  it('speaks about the record rather than about the care', () => {
    // Staff may have been there all day and written it up under another date.
    expect(emptyDayMessage('2026-03-01', '2026-03-02')).toBe(
      'Nothing was written down on this day.',
    );
    expect(emptyDayMessage('2026-03-02', '2026-03-02')).toBe(
      'Nothing has been written down yet today.',
    );
  });

  it('says so plainly when the day has not happened', () => {
    expect(emptyDayMessage('2026-03-09', '2026-03-02')).toBe('This day has not happened yet.');
  });
});

describe('the timeline', () => {
  it('interleaves checks and diary entries, oldest first', () => {
    /*
     * The bug the browser found: two lists put a 13:45 check above a 10:45
     * walk. A person reading their own day reads it as a day.
     */
    const day: MyDay = {
      date: '2026-03-02',
      checks: [
        {
          id: 'c1',
          recordedAt: '2026-03-02T13:45:00Z',
          templateName: 'Afternoon check',
          recordedByName: null,
          values: [],
        },
        {
          id: 'c2',
          recordedAt: '2026-03-02T09:00:00Z',
          templateName: 'Morning check',
          recordedByName: null,
          values: [],
        },
      ],
      diary: [
        {
          id: 'd1',
          occurredAt: '2026-03-02T10:45:00Z',
          categoryLabel: 'Activity',
          body: 'Walked to the market.',
          recordedByName: null,
          photos: [],
          edited: false,
        },
      ],
    };

    expect(myDayTimeline(day).map((item) => item.at)).toEqual([
      '2026-03-02T09:00:00Z',
      '2026-03-02T10:45:00Z',
      '2026-03-02T13:45:00Z',
    ]);
    expect(myDayTimeline(day).map((item) => item.kind)).toEqual(['check', 'entry', 'check']);
  });

  it('is empty for a day with nothing on it', () => {
    expect(myDayTimeline({ date: '2026-03-02', checks: [], diary: [] })).toEqual([]);
  });
});
