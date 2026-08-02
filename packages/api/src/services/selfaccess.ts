import {
  addDays,
  daysBetween,
  localDateOf,
  participantSeesWindow,
  SELF_ACCESS_MAX_DAYS,
  zonedTimeToUtc,
  type MyCheck,
  type MyDay,
  type MyDiaryEntry,
  type MyRecords,
  type Role,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import { HttpError } from '../middleware/errors.js';
import { getOrgSettings } from './org.js';
import { findParticipant, toSummary } from './participants.js';
import { listWindows } from './windows.js';
import { listDiaryEntries } from './diary.js';
import { entryDetails, unscheduledEntries } from './reports.js';

/**
 * Participant self-access (doc 01 §3.5, doc 04 §11, doc 06 §6).
 *
 * The person the record is about, reading their own record.
 *
 * Two rules hold everything here up.
 *
 * The first is that **the participant id is never an input**. It comes off the
 * principal and nowhere else, so there is no id in a path, no id in a query
 * string, and nothing for a scope check to get wrong. `assertInScope` is not
 * called in this file because there is no supplied id to check: the only
 * record reachable is the one the account is tied to. A self-access account
 * that could name a participant would be a self-access account one typo away
 * from reading somebody else's day.
 *
 * The second is that these DTOs are **built, not filtered**. Every field on a
 * `MyDay` is assigned here by name from a source that was checked. Nothing is
 * spread in from a staff DTO, so a field added to a check window in a later
 * phase cannot arrive on a participant's screen by inheritance.
 */

export type SelfAccessPrincipal = {
  userId: string;
  role: Role;
  deviceId: string | null;
  /** The participant this account is. Null on any staff account. */
  participantId: string | null;
};

/**
 * The account has to be a self-access one, and it has to be tied to a record.
 *
 * The schema constraint on `users` already guarantees the pairing, so a null
 * here means something is wrong rather than something a participant did. It
 * still refuses rather than assuming, because the alternative to refusing is
 * querying with a null id.
 */
export function selfParticipantId(principal: SelfAccessPrincipal): string {
  if (principal.role !== 'participant' || principal.participantId === null) {
    throw new HttpError('scope_denied', 'These screens are for a self-access account.');
  }
  return principal.participantId;
}

/** Today, in the org timezone. The server decides, not the caller's clock. */
export async function selfAccessToday(db: Database): Promise<string> {
  const org = await getOrgSettings(db);
  return localDateOf(new Date(), org.timezone);
}

function assertRange(from: string, to: string): void {
  if (daysBetween(from, to) + 1 > SELF_ACCESS_MAX_DAYS) {
    throw new HttpError(
      'validation_failed',
      `That is more than ${SELF_ACCESS_MAX_DAYS} days. Choose a shorter period.`,
    );
  }
}

/**
 * A date range of the participant's own record.
 *
 * One function for both screens: "my day" is this over a single date, and
 * assembling a day two different ways is how the day on screen and the day in
 * the PDF start disagreeing.
 */
export async function myRecords(
  db: Database,
  keyRing: KeyRing,
  principal: SelfAccessPrincipal,
  query: { from: string; to: string },
): Promise<MyRecords> {
  const participantId = selfParticipantId(principal);
  assertRange(query.from, query.to);

  const org = await getOrgSettings(db);
  const participant = await findParticipant(db, participantId);
  const summary = toSummary(keyRing, participant);

  const windows = await listWindows(
    db,
    keyRing,
    participantId,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );

  /*
   * The status filter first, so nothing that was missed or is still open even
   * reaches the entry lookup. Filtering later would work; filtering here means
   * a missed window has no row to leak from.
   */
  const recorded = windows.filter(
    (window) => participantSeesWindow(window.status) && window.entryId !== null,
  );

  const details = await entryDetails(
    db,
    keyRing,
    recorded.map((window) => window.entryId).filter((id): id is string => id !== null),
  );

  /*
   * Checks recorded on demand (D89). A blood pressure somebody asked for is as
   * much part of this person's record as one a schedule asked for, and leaving
   * it out would mean their copy quietly disagreed with the daily report.
   *
   * D72 does not apply here: it keeps missed and pending checks out, and an
   * unscheduled check is neither. It exists because somebody recorded it.
   */
  const unscheduled = await unscheduledEntries(
    db,
    keyRing,
    participantId,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );

  /*
   * `listDiaryEntries` applies `canReadDiaryEntry`, which drops entries staff
   * marked not visible and entries that have been deleted. That rule lives in
   * shared and is the same one the staff screens use from the other side, so
   * there is no second definition of "visible to the participant" here.
   */
  const diary = await listDiaryEntries(
    db,
    keyRing,
    participantId,
    { from: query.from, to: query.to, limit: 200 },
    {
      userId: principal.userId,
      role: principal.role,
      deviceId: principal.deviceId,
      ownParticipantId: participantId,
    },
    org.timezone,
  );

  const days: MyDay[] = [];
  for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
    const scheduled: MyCheck[] = recorded
      .filter((window) => localDateOf(new Date(window.startsAt), org.timezone) === date)
      .map((window) => {
        const detail = details.get(window.entryId!);
        return {
          id: window.id,
          recordedAt: detail?.recordedAt ?? window.startsAt,
          templateName: window.templateName,
          recordedByName: detail?.recordedByName ?? null,
          values: detail?.values ?? [],
        };
      });

    const onDemand: MyCheck[] = unscheduled
      .filter((check) => localDateOf(new Date(check.recordedAt), org.timezone) === date)
      .map((check) => ({
        id: check.id,
        recordedAt: check.recordedAt,
        templateName: check.templateName,
        recordedByName: check.recordedByName,
        values: check.values,
      }));

    /*
     * One list, not two. The person reading this has no reason to care whether
     * a schedule asked for a reading or somebody decided to take one, and the
     * shape carries nothing that would tell them apart.
     */
    const checks: MyCheck[] = [...scheduled, ...onDemand]
      // Oldest first: a person reads their own day forwards.
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));

    const entries: MyDiaryEntry[] = diary
      .filter((entry) => localDateOf(new Date(entry.occurredAt), org.timezone) === date)
      .map((entry) => ({
        id: entry.id,
        occurredAt: entry.occurredAt,
        categoryLabel: entry.categoryLabel,
        body: entry.body,
        recordedByName: entry.recordedByName,
        photos: entry.attachments
          .filter((one) => one.uploadState === 'complete')
          .map((one) => ({ id: one.id, isImage: one.isImage })),
        edited: entry.editCount > 0,
      }))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

    days.push({ date, checks, diary: entries });
  }

  return {
    participantName: `${summary.firstName} ${summary.lastName}`,
    orgName: org.orgName,
    timeZone: org.timezone,
    from: query.from,
    to: query.to,
    generatedAt: new Date().toISOString(),
    days,
  };
}

export async function myDay(
  db: Database,
  keyRing: KeyRing,
  principal: SelfAccessPrincipal,
  date: string,
): Promise<{ day: MyDay; today: string; participantName: string; timeZone: string }> {
  const records = await myRecords(db, keyRing, principal, { from: date, to: date });
  const today = await selfAccessToday(db);

  return {
    // The loop always produces one day for a single-date range.
    day: records.days[0] ?? { date, checks: [], diary: [] },
    today,
    participantName: records.participantName,
    timeZone: records.timeZone,
  };
}
