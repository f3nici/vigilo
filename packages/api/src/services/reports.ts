import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  addDays,
  countCompliance,
  completionPercent,
  countDoses,
  describeDoseStatus,
  emptyCounts,
  findGaps,
  formatFieldValue,
  localDateOf,
  orderedFields,
  participantShortName,
  summarise,
  zonedTimeToUtc,
  type ComplianceGrouping,
  type ComplianceReport,
  type ComplianceRow,
  type ComplianceWindow,
  type DailyDay,
  type DailyUnscheduledCheck,
  type DailyReport,
  type DailyWindow,
  type Scope,
  type TrendBucket,
  type TrendPoint,
  type TrendSeries,
  type DailyDose,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  checkEntries,
  checkEntryValues,
  checkTemplates,
  checkTemplateVersions,
  checkWindows,
  missedReasonCodes,
  participantAlerts,
  participants,
  users,
  windowMissReasons,
} from '../db/schema.js';
import { decryptOptional } from '../crypto/fields.js';
import { HttpError } from '../middleware/errors.js';
import { getOrgSettings } from './org.js';
import { findParticipant, toSummary } from './participants.js';
import { toAlert } from './alerts.js';
import { listDiaryEntries } from './diary.js';
import { listWindows, MISS_NOTE_COLUMN, VALUE_TEXT_COLUMN } from './windows.js';
import { administrationsFor, listDoses } from './doses.js';
import { parseSchema } from './templates.js';
import type { DiaryPrincipal } from './diary.js';

/**
 * Reports (doc 01 §8, doc 04 §11).
 *
 * Everything here reads. Nothing here decides anything the rest of the product
 * has not already decided: the compliance counting comes from
 * `@vigilo/shared`, the window statuses were settled by the state machine, and
 * the coverage question was answered when the window was materialised. A
 * report that recomputed any of that could disagree with the screen it was
 * printed from.
 *
 * Scope is the caller's, always. A report is one of the easiest places to
 * accidentally hand somebody a participant they have never been assigned to.
 */

export type ReportPrincipal = DiaryPrincipal & { scope: Scope; displayName: string };

function scopedParticipantIds(scope: Scope, requested?: string): string[] | 'all' {
  if (requested !== undefined) {
    if (scope.kind === 'ids' && !scope.participantIds.includes(requested)) {
      throw new HttpError('scope_denied', 'You are not assigned to this participant.');
    }
    return [requested];
  }
  return scope.kind === 'all' ? 'all' : scope.participantIds;
}

/* ------------------------------------------------------------ compliance */

/**
 * Windows in a date range, reduced to what compliance needs.
 *
 * One query with two joins rather than the full window DTO: a month across
 * twenty participants is thousands of rows, and none of what makes that DTO
 * expensive (template names, progress counts, decrypted miss notes) changes a
 * single number in the report.
 */
async function complianceRows(
  db: Database,
  scope: string[] | 'all',
  from: Date,
  to: Date,
): Promise<
  (ComplianceWindow & { participantId: string; startsAt: Date; recordedBy: string | null })[]
> {
  const filters = [gte(checkWindows.startsAt, from), lt(checkWindows.startsAt, to)];
  if (scope !== 'all') {
    if (scope.length === 0) return [];
    filters.push(inArray(checkWindows.participantId, scope));
  }

  const rows = await db
    .select({
      participantId: checkWindows.participantId,
      startsAt: checkWindows.startsAt,
      status: checkWindows.status,
      isLate: checkWindows.isLate,
      missReasonId: windowMissReasons.id,
      recordedBy: checkEntries.recordedBy,
    })
    .from(checkWindows)
    .leftJoin(windowMissReasons, eq(windowMissReasons.windowId, checkWindows.id))
    .leftJoin(checkEntries, eq(checkEntries.windowId, checkWindows.id))
    .where(and(...filters));

  return rows.map((row) => ({
    participantId: row.participantId,
    startsAt: row.startsAt,
    status: row.status,
    isLate: row.isLate,
    hasMissReason: row.missReasonId !== null,
    recordedBy: row.recordedBy,
  }));
}

/**
 * Checks recorded on demand in the window (D89), bucketed the same way the
 * scheduled ones are.
 *
 * A separate query because these have no `check_windows` row to join through.
 * Counted and reported beside the percentage, never inside it: nothing asked
 * for them, so they cannot be a check done on time.
 */
async function unscheduledRows(
  db: Database,
  scope: string[] | 'all',
  from: Date,
  to: Date,
): Promise<{ participantId: string; recordedAt: Date; recordedBy: string | null }[]> {
  const filters = [
    isNull(checkEntries.windowId),
    gte(checkEntries.recordedAt, from),
    lt(checkEntries.recordedAt, to),
  ];
  if (scope !== 'all') {
    if (scope.length === 0) return [];
    filters.push(inArray(checkEntries.participantId, scope));
  }

  return db
    .select({
      participantId: checkEntries.participantId,
      recordedAt: checkEntries.recordedAt,
      recordedBy: checkEntries.recordedBy,
    })
    .from(checkEntries)
    .where(and(...filters));
}

export async function complianceReport(
  db: Database,
  keyRing: KeyRing,
  principal: ReportPrincipal,
  query: {
    from: string;
    to: string;
    participantId?: string | undefined;
    userId?: string | undefined;
  },
  grouping: ComplianceGrouping,
): Promise<ComplianceReport> {
  const org = await getOrgSettings(db);
  const scope = scopedParticipantIds(principal.scope, query.participantId);

  const rows = await complianceRows(
    db,
    scope,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );

  /*
   * Filtering by worker after the fact rather than in the query.
   *
   * A window nobody recorded has no worker on it, so a WHERE on recorded_by
   * would silently drop every missed window, and a per-worker report that
   * cannot show a missed check is worse than no report.
   */
  const filtered =
    query.userId === undefined ? rows : rows.filter((row) => row.recordedBy === query.userId);

  const unscheduledAll = await unscheduledRows(
    db,
    scope,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );
  const unscheduled =
    query.userId === undefined
      ? unscheduledAll
      : unscheduledAll.filter((row) => row.recordedBy === query.userId);

  const unscheduledByKey = new Map<string, number>();
  for (const row of unscheduled) {
    const key =
      grouping === 'participant'
        ? row.participantId
        : grouping === 'worker'
          ? (row.recordedBy ?? 'nobody')
          : localDateOf(row.recordedAt, org.timezone);
    unscheduledByKey.set(key, (unscheduledByKey.get(key) ?? 0) + 1);
  }

  const buckets = new Map<string, typeof filtered>();
  for (const row of filtered) {
    const key =
      grouping === 'participant'
        ? row.participantId
        : grouping === 'worker'
          ? (row.recordedBy ?? 'nobody')
          : localDateOf(row.startsAt, org.timezone);

    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const labels = await labelsFor(db, keyRing, grouping, [
    ...new Set([...buckets.keys(), ...unscheduledByKey.keys()]),
  ]);

  /*
   * A bucket can hold unscheduled checks and no windows at all: a participant
   * with nothing scheduled who was still observed twice. Keyed off both maps so
   * that row appears rather than vanishing.
   */
  const keys = new Set([...buckets.keys(), ...unscheduledByKey.keys()]);

  const reportRows: ComplianceRow[] = [...keys]
    .map((key) => {
      const counts = countCompliance(buckets.get(key) ?? [], unscheduledByKey.get(key) ?? 0);
      return {
        key,
        label: labels.get(key) ?? key,
        counts,
        completionPercent: completionPercent(counts),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const total = countCompliance(filtered, unscheduled.length);

  return {
    from: query.from,
    to: query.to,
    timeZone: org.timezone,
    groupBy: grouping,
    rows: reportRows,
    total,
    totalPercent: completionPercent(total),
  };
}

async function labelsFor(
  db: Database,
  keyRing: KeyRing,
  grouping: ComplianceGrouping,
  keys: string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();

  if (grouping === 'day') return new Map(keys.map((key) => [key, key]));

  if (grouping === 'participant') {
    const rows = await db.select().from(participants).where(inArray(participants.id, keys));
    return new Map(
      rows.map((row) => [row.id, participantShortName(toSummary(keyRing, row))] as const),
    );
  }

  const ids = keys.filter((key) => key !== 'nobody');
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, ids));

  const labels = new Map(rows.map((row) => [row.id, row.displayName] as const));
  // A missed window has nobody on it, and saying so is the point of the row.
  labels.set('nobody', 'Nobody recorded it');
  return labels;
}

/* ---------------------------------------------------------------- trends */

export async function trendSeries(
  db: Database,
  principal: ReportPrincipal,
  query: { participantId: string; fieldKey: string; from: string; to: string; bucket: TrendBucket },
): Promise<TrendSeries> {
  const org = await getOrgSettings(db);
  scopedParticipantIds(principal.scope, query.participantId);

  const from = zonedTimeToUtc(query.from, 0, org.timezone);
  const to = zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone);

  /*
   * `value_number` is plaintext (A8), which is exactly why a trend is a plain
   * SQL read. The free text beside it stays encrypted and is not in this
   * query at all.
   */
  const rows = await db
    .select({
      recordedAt: checkEntryValues.recordedAt,
      value: checkEntryValues.valueNumber,
      unit: checkEntryValues.unit,
      versionId: checkEntries.templateVersionId,
    })
    .from(checkEntryValues)
    .innerJoin(checkEntries, eq(checkEntries.id, checkEntryValues.entryId))
    .where(
      and(
        eq(checkEntries.participantId, query.participantId),
        eq(checkEntryValues.fieldKey, query.fieldKey),
        sql`${checkEntryValues.valueNumber} is not null`,
        gte(checkEntryValues.recordedAt, from),
        lt(checkEntryValues.recordedAt, to),
      ),
    )
    .orderBy(asc(checkEntryValues.recordedAt));

  const raw = rows.map((row) => ({
    at: row.recordedAt.toISOString(),
    value: Number(row.value),
    unit: row.unit,
  }));

  const points = bucketPoints(raw, query.bucket, org.timezone);

  return {
    participantId: query.participantId,
    fieldKey: query.fieldKey,
    label: await fieldLabel(db, rows[0]?.versionId ?? null, query.fieldKey),
    unit: raw[0]?.unit ?? null,
    from: query.from,
    to: query.to,
    timeZone: org.timezone,
    bucket: query.bucket,
    points,
    // Reported, never filled in. A line drawn across a two-day hole reads as
    // two days of steady readings (doc 01 §8).
    gaps: findGaps(points),
    ...summarise(points),
  };
}

/**
 * Averages within a bucket, and keeps an empty bucket out of the series.
 *
 * A day with no readings produces no point rather than a zero. Zero is a
 * reading somebody took; nothing is nothing.
 */
function bucketPoints(
  raw: readonly { at: string; value: number }[],
  bucket: TrendBucket,
  timeZone: string,
): TrendPoint[] {
  if (bucket === 'none') {
    return raw.map((one) => ({ at: one.at, value: one.value, samples: 1 }));
  }

  const groups = new Map<string, number[]>();
  for (const one of raw) {
    const day = localDateOf(new Date(one.at), timeZone);
    const key = bucket === 'day' ? day : startOfWeek(day);
    const values = groups.get(key) ?? [];
    values.push(one.value);
    groups.set(key, values);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({
      at: zonedTimeToUtc(day, 0, timeZone).toISOString(),
      value:
        Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
      samples: values.length,
    }));
}

/** Weeks start on Monday, which is how a roster reads. */
function startOfWeek(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = (parsed.getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

async function fieldLabel(
  db: Database,
  versionId: string | null,
  fieldKey: string,
): Promise<string> {
  if (versionId === null) return fieldKey;
  const [version] = await db
    .select()
    .from(checkTemplateVersions)
    .where(eq(checkTemplateVersions.id, versionId))
    .limit(1);
  if (!version) return fieldKey;

  return (
    orderedFields(parseSchema(version)).find((field) => field.key === fieldKey)?.label ?? fieldKey
  );
}

/** Which numeric fields this participant has readings for, for the picker. */
export async function trendableFields(
  db: Database,
  principal: ReportPrincipal,
  participantId: string,
): Promise<{ fieldKey: string; label: string; unit: string | null; readings: number }[]> {
  scopedParticipantIds(principal.scope, participantId);

  const rows = await db
    .select({
      fieldKey: checkEntryValues.fieldKey,
      unit: checkEntryValues.unit,
      versionId: checkEntries.templateVersionId,
      readings: sql<string>`count(*)::text`,
    })
    .from(checkEntryValues)
    .innerJoin(checkEntries, eq(checkEntries.id, checkEntryValues.entryId))
    .where(
      and(
        eq(checkEntries.participantId, participantId),
        sql`${checkEntryValues.valueNumber} is not null`,
      ),
    )
    .groupBy(checkEntryValues.fieldKey, checkEntryValues.unit, checkEntries.templateVersionId);

  const out: { fieldKey: string; label: string; unit: string | null; readings: number }[] = [];
  for (const row of rows) {
    out.push({
      fieldKey: row.fieldKey,
      label: await fieldLabel(db, row.versionId, row.fieldKey),
      unit: row.unit,
      readings: Number(row.readings),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/* ----------------------------------------------------------- daily report */

/** Zeroes, so a day with no medications still has every column. */
function emptyDoseCounts() {
  return countDoses([]);
}

/**
 * A participant's day, or a run of days.
 *
 * The same data whether it is rendered on screen or into a PDF, so the report
 * an auditor is handed says exactly what the admin saw before they printed it.
 */

/**
 * Checks recorded on demand for one participant over a range (D89).
 *
 * Reuses `entryDetails`, so an unscheduled check renders its values through
 * exactly the same formatter a scheduled one does. A report where the same
 * reading reads differently depending on whether anybody scheduled it would be
 * a report nobody could compare.
 */
export async function unscheduledEntries(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: Date,
  to: Date,
): Promise<DailyUnscheduledCheck[]> {
  const rows = await db
    .select({ id: checkEntries.id, templateId: checkTemplates.name })
    .from(checkEntries)
    .innerJoin(checkTemplateVersions, eq(checkTemplateVersions.id, checkEntries.templateVersionId))
    .innerJoin(checkTemplates, eq(checkTemplates.id, checkTemplateVersions.templateId))
    .where(
      and(
        eq(checkEntries.participantId, participantId),
        isNull(checkEntries.windowId),
        gte(checkEntries.recordedAt, from),
        lt(checkEntries.recordedAt, to),
      ),
    )
    .orderBy(asc(checkEntries.recordedAt));

  if (rows.length === 0) return [];

  const detail = await entryDetails(
    db,
    keyRing,
    rows.map((row) => row.id),
  );

  return rows.flatMap((row) => {
    const found = detail.get(row.id);
    if (!found) return [];
    return [
      {
        id: row.id,
        recordedAt: found.recordedAt,
        templateName: row.templateId,
        recordedByName: found.recordedByName,
        editCount: found.editCount,
        values: found.values,
      },
    ];
  });
}

export async function dailyReport(
  db: Database,
  keyRing: KeyRing,
  principal: ReportPrincipal,
  query: { participantId: string; from: string; to: string },
): Promise<DailyReport> {
  const org = await getOrgSettings(db);
  scopedParticipantIds(principal.scope, query.participantId);

  const participant = await findParticipant(db, query.participantId);
  const summary = toSummary(keyRing, participant);

  const alertRows = await db
    .select()
    .from(participantAlerts)
    .where(
      and(
        eq(participantAlerts.participantId, query.participantId),
        eq(participantAlerts.active, true),
      ),
    )
    .orderBy(asc(participantAlerts.sortOrder));

  const windows = await listWindows(
    db,
    keyRing,
    query.participantId,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );

  const diary = await listDiaryEntries(
    db,
    keyRing,
    query.participantId,
    { from: query.from, to: query.to, limit: 500 },
    principal,
    org.timezone,
  );

  const entryDetail = await entryDetails(
    db,
    keyRing,
    windows.map((window) => window.entryId).filter((id): id is string => id !== null),
  );

  const missNotes = await missReasonNotes(
    db,
    keyRing,
    windows.map((window) => window.id),
  );

  /*
   * Checks recorded on demand over the same range (D89). Fetched separately
   * because they have no window to come back through `listWindows`, and folded
   * into each day's list so the report stays one timeline of what happened.
   */
  const unscheduled = await unscheduledEntries(
    db,
    keyRing,
    query.participantId,
    zonedTimeToUtc(query.from, 0, org.timezone),
    zonedTimeToUtc(addDays(query.to, 1), 0, org.timezone),
  );

  const medications = await dailyDoses(
    db,
    keyRing,
    query.participantId,
    query.from,
    query.to,
    org.timezone,
  );
  const dosesOn = (date: string) =>
    medications.filter(
      (one) => localDateOf(new Date(one.dueAt ?? one.administeredAt!), org.timezone) === date,
    );

  const days: DailyDay[] = [];
  for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
    const dayWindows = windows.filter(
      (window) => localDateOf(new Date(window.startsAt), org.timezone) === date,
    );

    const dayUnscheduled = unscheduled.filter(
      (one: DailyUnscheduledCheck) => localDateOf(new Date(one.recordedAt), org.timezone) === date,
    );

    days.push({
      date,
      windows: dayWindows.map((window): DailyWindow => {
        const detail = window.entryId === null ? null : (entryDetail.get(window.entryId) ?? null);
        return {
          id: window.id,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          status: window.status,
          expected: window.expected,
          coverageReason: window.coverageReason,
          isLate: window.isLate,
          lateByMinutes: window.lateByMinutes,
          recordedByName: detail?.recordedByName ?? null,
          recordedAt: detail?.recordedAt ?? null,
          editCount: detail?.editCount ?? 0,
          values: detail?.values ?? [],
          missReason:
            window.missReason === null
              ? null
              : {
                  label: window.missReason.label,
                  note: missNotes.get(window.id) ?? null,
                },
        };
      }),
      unscheduled: dayUnscheduled,
      diary: diary
        .filter((entry) => localDateOf(new Date(entry.occurredAt), org.timezone) === date)
        .map((entry) => ({
          id: entry.id,
          occurredAt: entry.occurredAt,
          categoryLabel: entry.categoryLabel,
          body: entry.body,
          recordedByName: entry.recordedByName,
          editCount: entry.editCount,
          attachmentCount: entry.attachments.length,
        })),
      medications: dosesOn(date),
      counts: emptyCounts(),
      doseCounts: emptyDoseCounts(),
    });
  }

  for (const day of days) {
    day.counts = countCompliance(
      day.windows.map((window) => ({
        status: window.status,
        isLate: window.isLate,
        hasMissReason: window.missReason !== null,
      })),
      day.unscheduled.length,
    );
    // PRN doses answered no schedule, so they are shown but never counted:
    // folding them in would put a number in the denominator that nothing was
    // ever due for.
    day.doseCounts = countDoses(day.medications.filter((one) => !one.isPrn));
  }

  return {
    participant: {
      id: summary.id,
      name: `${summary.firstName} ${summary.lastName}`,
      dateOfBirth: decryptOptional(keyRing, 'participants.dob_enc', participant.dobEnc) ?? '',
      ndisNumber:
        decryptOptional(keyRing, 'participants.ndis_number_enc', participant.ndisNumberEnc) ?? '',
    },
    alerts: alertRows.map((row) => {
      const alert = toAlert(keyRing, row);
      return { kind: alert.kind, severity: alert.severity, text: alert.text };
    }),
    from: query.from,
    to: query.to,
    timeZone: org.timezone,
    orgName: org.orgName,
    generatedAt: new Date().toISOString(),
    generatedByName: principal.displayName,
    days,
    total: countCompliance(
      windows.map((window) => ({
        status: window.status,
        isLate: window.isLate,
        hasMissReason: window.missReason !== null,
      })),
      unscheduled.length,
    ),
    doseTotal: countDoses(medications.filter((one) => !one.isPrn)),
  };
}

/**
 * The day's medication lines (doc 01 §8.1).
 *
 * Scheduled doses and PRN ones in one list, because the report is a timeline of
 * what happened rather than two lists a reader has to reconcile. A dose nobody
 * answered is included with no time against it, which is exactly the line an
 * auditor is looking for.
 */
async function dailyDoses(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  from: string,
  to: string,
  timeZone: string,
): Promise<DailyDose[]> {
  const start = zonedTimeToUtc(from, 0, timeZone);
  const end = zonedTimeToUtc(addDays(to, 1), 0, timeZone);

  const [doses, administrations] = await Promise.all([
    listDoses(db, keyRing, participantId, start, end),
    administrationsFor(db, keyRing, participantId, start, end),
  ]);

  const byDose = new Map(
    administrations.filter((one) => one.doseId !== null).map((one) => [one.doseId!, one] as const),
  );

  const scheduled: DailyDose[] = doses.map((dose) => {
    const signOff = byDose.get(dose.id) ?? null;
    return {
      id: dose.id,
      medicationName: dose.medicationName,
      dose: dose.dose,
      isPrn: false,
      dueAt: dose.dueAt,
      administeredAt: signOff?.administeredAt ?? null,
      status: dose.status,
      statusLabel: describeDoseStatus(dose.status),
      expected: dose.expected,
      coverageReason: dose.coverageReason,
      isLate: dose.isLate,
      recordedByName: signOff?.recordedByName ?? null,
      witnessedByName: signOff?.witnessedByName ?? null,
      note: signOff?.note ?? null,
      reason: null,
      outcome: null,
    };
  });

  const prn: DailyDose[] = administrations
    .filter((one) => one.doseId === null)
    .map((one) => ({
      id: one.id,
      medicationName: one.medicationName,
      dose: one.dose,
      isPrn: true,
      dueAt: null,
      administeredAt: one.administeredAt,
      status: one.status,
      statusLabel: describeDoseStatus(one.status),
      // A PRN dose was never expected by a schedule, and was never unexpected
      // either. It is out of the counting entirely.
      expected: false,
      coverageReason: null,
      isLate: false,
      recordedByName: one.recordedByName,
      witnessedByName: one.witnessedByName,
      note: one.note,
      reason: one.reason,
      outcome: one.outcome,
    }));

  return [...scheduled, ...prn].sort(
    (a, b) => Date.parse(a.dueAt ?? a.administeredAt!) - Date.parse(b.dueAt ?? b.administeredAt!),
  );
}

export type EntryDetail = {
  recordedByName: string | null;
  recordedAt: string;
  editCount: number;
  values: { fieldKey: string; label: string; display: string }[];
};

/**
 * Exported because the self-access day renders the same readings from the same
 * entries. Two functions turning a check entry into a list of labelled values
 * would be two chances to render a number differently on the participant's
 * copy of their own record.
 */
export async function entryDetails(
  db: Database,
  keyRing: KeyRing,
  entryIds: readonly string[],
): Promise<Map<string, EntryDetail>> {
  if (entryIds.length === 0) return new Map();

  const rows = await db
    .select({ entry: checkEntries, recordedByName: users.displayName })
    .from(checkEntries)
    .leftJoin(users, eq(users.id, checkEntries.recordedBy))
    .where(inArray(checkEntries.id, [...entryIds]));

  const values = await db
    .select()
    .from(checkEntryValues)
    .where(inArray(checkEntryValues.entryId, [...entryIds]));

  const versionIds = [...new Set(rows.map((row) => row.entry.templateVersionId))];
  const versions =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(checkTemplateVersions)
          .where(inArray(checkTemplateVersions.id, versionIds));

  const fieldsByVersion = new Map(
    versions.map((version) => [version.id, orderedFields(parseSchema(version))] as const),
  );

  const byEntry = new Map<string, typeof values>();
  for (const value of values) {
    const bucket = byEntry.get(value.entryId) ?? [];
    bucket.push(value);
    byEntry.set(value.entryId, bucket);
  }

  return new Map(
    rows.map((row) => {
      const fields = fieldsByVersion.get(row.entry.templateVersionId) ?? [];
      const recorded = byEntry.get(row.entry.id) ?? [];

      // Ordered by the form, not by what happens to be in the database, so
      // the report reads down the page the way the worker filled it in.
      const rendered = fields
        .map((field) => {
          const value = recorded.find((one) => one.fieldKey === field.key);
          if (!value) return null;
          const display = formatFieldValue(field, {
            number: value.valueNumber === null ? null : Number(value.valueNumber),
            bool: value.valueBool,
            text: decryptOptional(keyRing, VALUE_TEXT_COLUMN, value.valueTextEnc),
            json: (value.valueJson ?? null) as string | string[] | null,
            unit: value.unit,
          });
          return display === '' ? null : { fieldKey: field.key, label: field.label, display };
        })
        .filter((one): one is { fieldKey: string; label: string; display: string } => one !== null);

      return [
        row.entry.id,
        {
          recordedByName: row.recordedByName,
          recordedAt: row.entry.recordedAt.toISOString(),
          editCount: row.entry.editCount,
          values: rendered,
        },
      ] as const;
    }),
  );
}

async function missReasonNotes(
  db: Database,
  keyRing: KeyRing,
  windowIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (windowIds.length === 0) return new Map();

  const rows = await db
    .select({ windowId: windowMissReasons.windowId, noteEnc: windowMissReasons.noteEnc })
    .from(windowMissReasons)
    .innerJoin(missedReasonCodes, eq(missedReasonCodes.id, windowMissReasons.reasonCodeId))
    .where(inArray(windowMissReasons.windowId, [...windowIds]));

  return new Map(
    rows.map((row) => [row.windowId, decryptOptional(keyRing, MISS_NOTE_COLUMN, row.noteEnc)]),
  );
}
