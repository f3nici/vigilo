import { and, asc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  DEVICE_WINDOW_DAYS_BACK,
  DEVICE_WINDOW_DAYS_FORWARD,
  DEVICE_RECORD_RETENTION_DAYS,
  sortForApply,
  type OutboxOperation,
  type Scope,
  type SyncBootstrapResponse,
  type SyncChange,
  type SyncChangesResponse,
  type SyncEntity,
  type SyncPushResult,
  type SyncScopeChange,
  type SyncTombstone,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import type { KeyRing } from '../crypto/keys.js';
import {
  attachments,
  checkEntries,
  checkSchedules,
  checkTemplateVersions,
  checkTemplates,
  checkWindows,
  diaryCategories,
  diaryEntries,
  emergencyContacts,
  emergencyPlans,
  medicationAdministrations,
  medicationDoses,
  medications,
  missedReasonCodes,
  participantAlerts,
  participants,
  syncAppliedOps,
  syncDeletions,
  syncScopeChanges,
  windowMissReasons,
  users,
} from '../db/schema.js';
import { HttpError } from '../middleware/errors.js';
import { resolveScopeDetail, type ScopePrincipal } from './scope.js';
import { listParticipants } from './participants.js';
import { toAlert } from './alerts.js';
import { toContact, toPlan } from './contacts.js';
import { listTemplates, toVersion } from './templates.js';
import { getSchedule } from './schedules.js';
import { toCode } from './reasonCodes.js';
import { toDiaryCategory, diaryEntriesByIds, createDiaryEntry, updateDiaryEntry } from './diary.js';
import { createAttachment, toAttachment } from './attachments.js';
import { missReasonsByWindowIds, toCheckEntry, windowsByIds } from './windows.js';
import { putEntry, putMissReason } from './entries.js';
import { medicationsByIds } from './medications.js';
import { administrationsByIds, dosesByIds, recordPrn, signOffDose } from './doses.js';
import { getOrgSettings } from './org.js';
import type { AuditActor } from './audit.js';

/**
 * Sync (doc 04 §13, doc 05).
 *
 * Two directions, deliberately asymmetric. Pull is a cursor over one global
 * revision sequence, and every row it can return is filtered by the same scope
 * resolver every REST route uses, so a device is physically incapable of
 * receiving a participant it may not see. Push is a list of independently
 * applied operations, each keyed by an id the device generated, so replaying
 * one is a no-op rather than a duplicate clinical record.
 *
 * Nothing here reimplements a rule. Every operation lands through the same
 * service function the REST route calls, with the same validation, the same
 * conflict handling and the same audit row. A second code path that writes
 * check entries is a second code path that can be wrong.
 */

export type SyncPrincipal = ScopePrincipal & {
  deviceId: string | null;
};

type ScopeIds = 'all' | string[];

function scopeIdsOf(scope: Scope): ScopeIds {
  return scope.kind === 'all' ? 'all' : scope.participantIds;
}

/* -------------------------------------------------------------- collectors */

type ChangeKey = { id: string; participantId: string | null; revision: number };

type Source = {
  entity: SyncEntity;
  table: PgTable;
  id: AnyPgColumn;
  /** Null for org-wide reference data, which is sent to every device. */
  participantId: AnyPgColumn | null;
  revision: AnyPgColumn;
  /** Extra narrowing, such as the window range a device actually holds. */
  extra?: () => ReturnType<typeof and>;
  /**
   * For a table that reaches its participant through another one. Only miss
   * reasons need it: they hang off a window, not off a participant.
   */
  keys?: (db: Database, scope: ScopeIds, since: number, limit: number) => Promise<ChangeKey[]>;
  load: (
    db: Database,
    keyRing: KeyRing,
    keys: ChangeKey[],
    principal: SyncPrincipal,
  ) => Promise<Map<string, SyncChange['row']>>;
};

/**
 * Rows changed after `since`, in revision order, already narrowed to scope.
 *
 * Scope is a WHERE clause rather than a filter applied afterwards. Fetching a
 * page and then discarding what the caller may not see would still have read
 * it, and would make the page size depend on data the caller cannot know
 * about.
 */
async function changedKeys(
  db: Database,
  source: Source,
  scope: ScopeIds,
  since: number,
  limit: number,
): Promise<ChangeKey[]> {
  if (source.keys) return source.keys(db, scope, since, limit);

  const filters = [gt(source.revision, since)];

  if (source.participantId !== null && scope !== 'all') {
    if (scope.length === 0) return [];
    filters.push(inArray(source.participantId, scope));
  }

  const extra = source.extra?.();
  if (extra) filters.push(extra);

  const rows = await db
    .select({
      id: source.id,
      participantId: source.participantId === null ? sql<null>`null` : source.participantId,
      revision: source.revision,
    })
    .from(source.table)
    .where(and(...filters))
    .orderBy(asc(source.revision))
    .limit(limit);

  return rows.map((row) => ({
    id: String(row.id),
    participantId: row.participantId === null ? null : String(row.participantId),
    revision: Number(row.revision),
  }));
}

/** A loader that turns a list of DTOs into the id-keyed map a source returns. */
function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function windowRangeForDevice(now: Date) {
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(now.getTime() - DEVICE_WINDOW_DAYS_BACK * day),
    to: new Date(now.getTime() + DEVICE_WINDOW_DAYS_FORWARD * day),
  };
}

function recordCutoffForDevice(now: Date): Date {
  return new Date(now.getTime() - DEVICE_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Every source, in the order a page is applied.
 *
 * The order matters on the device, not here: a diary entry that lands before
 * its category has nothing to render its chip from. `sortForApply` in shared
 * enforces it on both sides from this same list.
 */
function sources(now: Date): Source[] {
  const windowRange = windowRangeForDevice(now);
  const cutoff = recordCutoffForDevice(now);

  return [
    {
      entity: 'participant',
      table: participants,
      id: participants.id,
      participantId: participants.id,
      revision: participants.revision,
      load: async (db, keyRing, keys, principal) => {
        const { access } = await resolveScopeDetail(db, principal);
        return byId(
          await listParticipants(
            db,
            keyRing,
            keys.map((key) => key.id),
            access,
            // An archived participant still travels, so the device learns it is
            // archived rather than keeping the last active copy forever.
            { includeArchived: true },
          ),
        );
      },
    },
    {
      entity: 'participant_alert',
      table: participantAlerts,
      id: participantAlerts.id,
      participantId: participantAlerts.participantId,
      revision: participantAlerts.revision,
      load: async (db, keyRing, keys) => {
        const rows = await db
          .select()
          .from(participantAlerts)
          .where(
            inArray(
              participantAlerts.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map((row) => toAlert(keyRing, row)));
      },
    },
    {
      entity: 'emergency_contact',
      table: emergencyContacts,
      id: emergencyContacts.id,
      participantId: emergencyContacts.participantId,
      revision: emergencyContacts.revision,
      load: async (db, keyRing, keys) => {
        const rows = await db
          .select()
          .from(emergencyContacts)
          .where(
            inArray(
              emergencyContacts.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map((row) => toContact(keyRing, row)));
      },
    },
    {
      entity: 'emergency_plan',
      table: emergencyPlans,
      // One plan per participant, so the participant id is the row's identity.
      id: emergencyPlans.participantId,
      participantId: emergencyPlans.participantId,
      revision: emergencyPlans.revision,
      load: async (db, keyRing, keys) => {
        const rows = await db
          .select()
          .from(emergencyPlans)
          .where(
            inArray(
              emergencyPlans.participantId,
              keys.map((key) => key.id),
            ),
          );
        return new Map(rows.map((row) => [row.participantId, toPlan(keyRing, row)]));
      },
    },
    {
      entity: 'check_template',
      table: checkTemplates,
      id: checkTemplates.id,
      participantId: null,
      revision: checkTemplates.revision,
      load: async (db, _keyRing, keys) => {
        const wanted = new Set(keys.map((key) => key.id));
        const all = await listTemplates(db, { includeRetired: true });
        return byId(all.filter((template) => wanted.has(template.id)));
      },
    },
    {
      entity: 'check_template_version',
      table: checkTemplateVersions,
      id: checkTemplateVersions.id,
      participantId: null,
      revision: checkTemplateVersions.revision,
      load: async (db, _keyRing, keys) => {
        const rows = await db
          .select({ version: checkTemplateVersions, publishedByName: users.displayName })
          .from(checkTemplateVersions)
          .leftJoin(users, eq(users.id, checkTemplateVersions.publishedBy))
          .where(
            inArray(
              checkTemplateVersions.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map((row) => toVersion(row.version, row.publishedByName)));
      },
    },
    {
      entity: 'check_schedule',
      table: checkSchedules,
      id: checkSchedules.id,
      participantId: checkSchedules.participantId,
      revision: checkSchedules.revision,
      load: async (db, _keyRing, keys) => {
        const schedules = await Promise.all(keys.map((key) => getSchedule(db, key.id)));
        return byId(schedules);
      },
    },
    {
      entity: 'medication',
      table: medications,
      id: medications.id,
      participantId: medications.participantId,
      revision: medications.revision,
      load: async (db, keyRing, keys) =>
        byId(
          await medicationsByIds(
            db,
            keyRing,
            keys.map((key) => key.id),
          ),
        ),
    },
    {
      entity: 'missed_reason_code',
      table: missedReasonCodes,
      id: missedReasonCodes.id,
      participantId: null,
      revision: missedReasonCodes.revision,
      load: async (db, _keyRing, keys) => {
        const rows = await db
          .select()
          .from(missedReasonCodes)
          .where(
            inArray(
              missedReasonCodes.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map(toCode));
      },
    },
    {
      entity: 'diary_category',
      table: diaryCategories,
      id: diaryCategories.id,
      participantId: null,
      revision: diaryCategories.revision,
      load: async (db, _keyRing, keys) => {
        const rows = await db
          .select()
          .from(diaryCategories)
          .where(
            inArray(
              diaryCategories.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map(toDiaryCategory));
      },
    },
    {
      entity: 'check_window',
      table: checkWindows,
      id: checkWindows.id,
      participantId: checkWindows.participantId,
      revision: checkWindows.revision,
      // Seven days back to seven days forward (doc 05 §4). A device that has
      // been offline a week still has windows to record against, and a phone
      // does not accumulate a year of them.
      extra: () =>
        and(
          gte(checkWindows.startsAt, windowRange.from),
          lt(checkWindows.startsAt, windowRange.to),
        ),
      load: async (db, keyRing, keys) =>
        byId(
          await windowsByIds(
            db,
            keyRing,
            keys.map((key) => key.id),
          ),
        ),
    },
    {
      entity: 'check_entry',
      table: checkEntries,
      id: checkEntries.id,
      participantId: checkEntries.participantId,
      revision: checkEntries.revision,
      extra: () => and(gte(checkEntries.recordedAt, cutoff)),
      load: async (db, keyRing, keys) => {
        const rows = await db
          .select()
          .from(checkEntries)
          .where(
            inArray(
              checkEntries.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(await Promise.all(rows.map((row) => toCheckEntry(db, keyRing, row))));
      },
    },
    {
      entity: 'window_miss_reason',
      table: windowMissReasons,
      id: windowMissReasons.id,
      // A miss reason carries no participant of its own. It reaches one through
      // the window it explains, so its keys come from a join rather than from
      // the generic query.
      participantId: null,
      revision: windowMissReasons.revision,
      keys: async (db, scope, since, limit) => {
        const filters = [
          gt(windowMissReasons.revision, since),
          gte(windowMissReasons.recordedAt, cutoff),
        ];
        if (scope !== 'all') {
          if (scope.length === 0) return [];
          filters.push(inArray(checkWindows.participantId, scope));
        }

        const rows = await db
          .select({
            id: windowMissReasons.id,
            participantId: checkWindows.participantId,
            revision: windowMissReasons.revision,
          })
          .from(windowMissReasons)
          .innerJoin(checkWindows, eq(checkWindows.id, windowMissReasons.windowId))
          .where(and(...filters))
          .orderBy(asc(windowMissReasons.revision))
          .limit(limit);

        return rows.map((row) => ({
          id: row.id,
          participantId: row.participantId,
          revision: Number(row.revision),
        }));
      },
      load: async (db, keyRing, keys) => {
        const rows = await db
          .select({ windowId: windowMissReasons.windowId })
          .from(windowMissReasons)
          .where(
            inArray(
              windowMissReasons.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(
          await missReasonsByWindowIds(
            db,
            keyRing,
            rows.map((row) => row.windowId),
          ),
        );
      },
    },
    {
      entity: 'medication_dose',
      table: medicationDoses,
      id: medicationDoses.id,
      participantId: medicationDoses.participantId,
      revision: medicationDoses.revision,
      // The same seven days back to seven days forward as check windows, and
      // for the same reason: a device that has been offline a week still has
      // doses to sign off, and a phone does not accumulate a year of them.
      extra: () =>
        and(
          gte(medicationDoses.dueAt, windowRange.from),
          lt(medicationDoses.dueAt, windowRange.to),
        ),
      load: async (db, keyRing, keys) =>
        byId(
          await dosesByIds(
            db,
            keyRing,
            keys.map((key) => key.id),
          ),
        ),
    },
    {
      entity: 'medication_administration',
      table: medicationAdministrations,
      id: medicationAdministrations.id,
      participantId: medicationAdministrations.participantId,
      revision: medicationAdministrations.revision,
      extra: () => and(gte(medicationAdministrations.administeredAt, cutoff)),
      load: async (db, keyRing, keys) =>
        byId(
          await administrationsByIds(
            db,
            keyRing,
            keys.map((key) => key.id),
          ),
        ),
    },
    {
      entity: 'diary_entry',
      table: diaryEntries,
      id: diaryEntries.id,
      participantId: diaryEntries.participantId,
      revision: diaryEntries.revision,
      extra: () => and(gte(diaryEntries.occurredAt, cutoff)),
      load: async (db, keyRing, keys) =>
        byId(
          await diaryEntriesByIds(
            db,
            keyRing,
            keys.map((key) => key.id),
          ),
        ),
    },
    {
      entity: 'attachment',
      table: attachments,
      id: attachments.id,
      participantId: attachments.participantId,
      revision: attachments.revision,
      load: async (db, _keyRing, keys) => {
        const rows = await db
          .select()
          .from(attachments)
          .where(
            inArray(
              attachments.id,
              keys.map((key) => key.id),
            ),
          );
        return byId(rows.map(toAttachment));
      },
    },
  ];
}

/**
 * Turns keys into changes.
 *
 * A key whose row the loader could not produce is dropped rather than sent as
 * a hole. That happens when a row is deleted between the two queries, and the
 * tombstone for it is already on its way.
 */
async function collect(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  source: Source,
  keys: ChangeKey[],
): Promise<SyncChange[]> {
  if (keys.length === 0) return [];
  const rows = await source.load(db, keyRing, keys, principal);

  const changes: SyncChange[] = [];
  for (const key of keys) {
    const row = rows.get(key.id);
    if (row === undefined) continue;
    changes.push({
      entity: source.entity,
      id: key.id,
      participantId: key.participantId,
      revision: key.revision,
      row,
    } as SyncChange);
  }
  return changes;
}

/* -------------------------------------------------------------- bootstrap */

/**
 * The whole scoped snapshot (doc 05 §4).
 *
 * A new device, a reinstall, a device more than 30 days stale, or a device
 * that detected its own local database had been evicted. Cheaper and safer
 * than walking a long change history, and it is the recovery path for any
 * local corruption: wipe local, bootstrap again.
 */
export async function bootstrap(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  now = new Date(),
): Promise<SyncBootstrapResponse> {
  const { scope } = await resolveScopeDetail(db, principal, now);
  const ids = scopeIdsOf(scope);

  // Read the sequence first. Anything committed after this point carries a
  // higher revision and arrives on the next pull, so the snapshot is never
  // missing a change: at worst it repeats one, which is harmless.
  const revision = await currentRevision(db);

  const changes: SyncChange[] = [];
  for (const source of sources(now)) {
    // No `since` filter, so this is everything the device may hold. The page
    // limit is deliberately absent: a bootstrap is one large response rather
    // than a paginated walk, which is the entire reason it is cheaper.
    const keys = await changedKeys(db, source, ids, 0, 10_000);
    changes.push(...(await collect(db, keyRing, principal, source, keys)));
  }

  const org = await getOrgSettings(db);

  return {
    changes: sortForApply(changes),
    revision,
    serverTime: now.toISOString(),
    timeZone: org.timezone,
    participantIds: ids === 'all' ? await allParticipantIds(db) : ids,
    retentionDays: DEVICE_RECORD_RETENTION_DAYS,
  };
}

async function allParticipantIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: participants.id }).from(participants);
  return rows.map((row) => row.id);
}

async function currentRevision(db: Database): Promise<number> {
  const [row] = await db.execute<{ value: string }>(
    sql`select last_value::text as value from global_revision_seq`,
  );
  return Number(row?.value ?? 0);
}

/* ------------------------------------------------------------------ changes */

/**
 * One page of changes after `since`.
 *
 * Every source is asked for up to `limit` rows, the results are merged in
 * revision order, and the page is cut at `limit`. `nextRevision` is the
 * revision of the last row in the cut page, never the highest revision seen,
 * so a row that did not fit is fetched again by the next call rather than
 * skipped.
 */
export async function changesSince(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  since: number,
  limit: number,
  now = new Date(),
): Promise<SyncChangesResponse> {
  const { scope } = await resolveScopeDetail(db, principal, now);
  const ids = scopeIdsOf(scope);

  // One more than the page from every source, so a source that filled the
  // page on its own can still say there is more behind it. Without the spare
  // row, a run of twelve changes in one table reads as a page of ten and
  // nothing further, and the cursor stops.
  const fetch = limit + 1;

  const collected: SyncChange[] = [];
  for (const source of sources(now)) {
    const keys = await changedKeys(db, source, ids, since, fetch);
    collected.push(...(await collect(db, keyRing, principal, source, keys)));
  }

  const [tombstones, scopeChanges] = await Promise.all([
    tombstonesSince(db, ids, since, fetch),
    scopeChangesSince(db, principal.userId, since, fetch),
  ]);

  // Tombstones and scope changes share the cursor with everything else, so
  // they are merged into the same ordering before the page is cut. A deletion
  // that lands after the cut must not be lost because the cursor moved past it.
  const everything = [
    ...sortForApply(collected),
    ...tombstones.map((tombstone) => ({ revision: tombstone.revision, tombstone })),
    ...scopeChanges.map((change) => ({ revision: change.revision, scopeChange: change })),
  ].sort((a, b) => a.revision - b.revision);

  const page = everything.slice(0, limit);
  const hasMore = everything.length > page.length;

  const changes: SyncChange[] = [];
  const pageTombstones: SyncTombstone[] = [];
  const pageScopeChanges: SyncScopeChange[] = [];

  for (const item of page) {
    if ('tombstone' in item) pageTombstones.push(item.tombstone);
    else if ('scopeChange' in item) pageScopeChanges.push(item.scopeChange);
    else changes.push(item as SyncChange);
  }

  const last = page.at(-1);

  return {
    changes: sortForApply(changes),
    tombstones: pageTombstones,
    scopeChanges: pageScopeChanges,
    // An empty page leaves the cursor where it was rather than advancing it to
    // the head of the sequence, which would skip anything written in between.
    nextRevision: last?.revision ?? since,
    hasMore,
    serverRevision: await currentRevision(db),
    serverTime: now.toISOString(),
  };
}

async function tombstonesSince(
  db: Database,
  scope: ScopeIds,
  since: number,
  limit: number,
): Promise<SyncTombstone[]> {
  const filters = [gt(syncDeletions.revision, since)];
  if (scope !== 'all') {
    if (scope.length === 0) {
      // Org-wide tombstones still apply to a user with no participants.
      filters.push(sql`${syncDeletions.participantId} is null`);
    } else {
      filters.push(
        sql`(${syncDeletions.participantId} is null or ${inArray(syncDeletions.participantId, scope)})`,
      );
    }
  }

  const rows = await db
    .select()
    .from(syncDeletions)
    .where(and(...filters))
    .orderBy(asc(syncDeletions.revision))
    .limit(limit);

  return rows.map((row) => ({
    entity: row.entityType as SyncEntity,
    id: row.entityId,
    participantId: row.participantId,
    deletedAt: row.deletedAt.toISOString(),
    revision: row.revision,
  }));
}

async function scopeChangesSince(
  db: Database,
  userId: string,
  since: number,
  limit: number,
): Promise<SyncScopeChange[]> {
  const rows = await db
    .select()
    .from(syncScopeChanges)
    .where(and(eq(syncScopeChanges.userId, userId), gt(syncScopeChanges.revision, since)))
    .orderBy(asc(syncScopeChanges.revision))
    .limit(limit);

  return rows.map((row) => ({
    participantId: row.participantId,
    effect: row.effect,
    at: row.at.toISOString(),
    revision: row.revision,
  }));
}

/* --------------------------------------------------------------------- push */

/**
 * A batch of operations, each applied on its own.
 *
 * One rejected operation must never block the other 49, so every operation is
 * caught individually and reported individually. The device clears the ones
 * that landed and holds the ones that did not.
 */
export async function applyOperations(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  operations: readonly OutboxOperation[],
  actor: AuditActor,
  now = new Date(),
): Promise<{ results: SyncPushResult[]; serverRevision: number }> {
  const { scope } = await resolveScopeDetail(db, principal, now);
  const results: SyncPushResult[] = [];

  for (const operation of operations) {
    results.push(await applyOne(db, keyRing, principal, scope, operation, actor));
  }

  return { results, serverRevision: await currentRevision(db) };
}

async function applyOne(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  scope: Scope,
  operation: OutboxOperation,
  actor: AuditActor,
): Promise<SyncPushResult> {
  // The replay check comes first, before scope. An operation applied while the
  // worker still had access must return the same answer after the access was
  // revoked, or a device that lost a response would retry forever against a
  // record the server already holds.
  const [seen] = await db
    .select()
    .from(syncAppliedOps)
    .where(eq(syncAppliedOps.opId, operation.opId))
    .limit(1);
  if (seen) {
    return { opId: operation.opId, status: 'duplicate', revision: seen.revision };
  }

  try {
    const applied = await dispatch(db, keyRing, principal, scope, operation, actor);

    await db.insert(syncAppliedOps).values({
      opId: operation.opId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      kind: operation.kind,
      entityId: applied.entityId,
      revision: applied.revision,
    });

    return { opId: operation.opId, status: 'applied', revision: applied.revision };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        opId: operation.opId,
        status: 'rejected',
        error: { code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

type Applied = { entityId: string; revision: number };

async function dispatch(
  db: Database,
  keyRing: KeyRing,
  principal: SyncPrincipal,
  scope: Scope,
  operation: OutboxOperation,
  actor: AuditActor,
): Promise<Applied> {
  switch (operation.kind) {
    case 'check_entry.put': {
      // Scope is checked here rather than deeper, and it is checked before
      // anything is written, exactly as the REST routes do it.
      assertPushScope(scope, operation.participantId);
      const windowId =
        operation.windowId ??
        (await bindWindow(db, operation.participantId, new Date(operation.payload.recordedAt)));
      const { entry } = await putEntry(
        db,
        keyRing,
        windowId,
        operation.payload,
        { userId: principal.userId, role: principal.role, deviceId: principal.deviceId },
        actor,
        { recordedOffline: true },
      );
      return { entityId: entry.id, revision: await revisionOf(db, checkEntries, entry.id) };
    }

    case 'miss_reason.put': {
      assertPushScope(scope, operation.participantId);
      const reason = await putMissReason(
        db,
        keyRing,
        operation.windowId,
        operation.payload,
        { userId: principal.userId, role: principal.role, deviceId: principal.deviceId },
        actor,
      );
      return {
        entityId: reason.id,
        revision: await revisionOf(db, windowMissReasons, reason.id),
      };
    }

    case 'medication.sign_off': {
      assertPushScope(scope, operation.participantId);
      const { administration } = await signOffDose(
        db,
        keyRing,
        operation.doseId,
        operation.payload,
        { userId: principal.userId, role: principal.role, deviceId: principal.deviceId },
        actor,
        { recordedOffline: true },
      );
      return {
        entityId: administration.id,
        revision: await revisionOf(db, medicationAdministrations, administration.id),
      };
    }

    case 'medication.prn': {
      assertPushScope(scope, operation.participantId);
      const administration = await recordPrn(
        db,
        keyRing,
        operation.participantId,
        operation.payload,
        { userId: principal.userId, role: principal.role, deviceId: principal.deviceId },
        actor,
        { recordedOffline: true },
      );
      return {
        entityId: administration.id,
        revision: await revisionOf(db, medicationAdministrations, administration.id),
      };
    }

    case 'diary_entry.create': {
      assertPushScope(scope, operation.participantId);
      const entry = await createDiaryEntry(
        db,
        keyRing,
        operation.participantId,
        operation.payload,
        {
          userId: principal.userId,
          role: principal.role,
          deviceId: principal.deviceId,
          ownParticipantId: principal.participantId,
        },
        actor,
      );
      return { entityId: entry.id, revision: await revisionOf(db, diaryEntries, entry.id) };
    }

    case 'diary_entry.update': {
      assertPushScope(scope, operation.participantId);
      const entry = await updateDiaryEntry(
        db,
        keyRing,
        operation.entryId,
        operation.payload,
        {
          userId: principal.userId,
          role: principal.role,
          deviceId: principal.deviceId,
          ownParticipantId: principal.participantId,
        },
        actor,
      );
      return { entityId: entry.id, revision: await revisionOf(db, diaryEntries, entry.id) };
    }

    case 'attachment.create': {
      assertPushScope(scope, operation.participantId);
      const attachment = await createAttachment(db, operation.participantId, operation.payload, {
        userId: principal.userId,
        role: principal.role,
      });
      return {
        entityId: attachment.id,
        revision: await revisionOf(db, attachments, attachment.id),
      };
    }
  }
}

/**
 * Scope on the way up, with one deliberate exception.
 *
 * A device that recorded a check before its access was revoked still has to be
 * able to send it. The care happened and the record must exist; refusing it
 * would destroy a real clinical record to enforce an access rule that is about
 * reading, not about what already occurred (doc 05 §6). So an operation for a
 * participant no longer in scope is accepted, and the device purges its local
 * copy when it applies the revocation.
 *
 * What is refused is an operation for a participant this user has never had
 * access to, which is not a late record, it is a forged one.
 */
function assertPushScope(scope: Scope, participantId: string): void {
  if (scope.kind === 'all') return;
  if (scope.participantIds.includes(participantId)) return;
  throw new HttpError('scope_denied', 'You are not assigned to this participant.');
}

async function revisionOf(
  db: Database,
  table:
    | typeof checkEntries
    | typeof diaryEntries
    | typeof attachments
    | typeof windowMissReasons
    | typeof medicationAdministrations,
  id: string,
): Promise<number> {
  const [row] = await db
    .select({ revision: table.revision })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return Number(row?.revision ?? 0);
}

/**
 * Finds the window an entry recorded with no window belongs to.
 *
 * A device offline for more than seven days runs out of materialised windows
 * and records against the clock instead. The server binds by timestamp on
 * arrival, which is the only place that binding can happen: a device that
 * could create a window could invent a schedule, and the fixed grid is the
 * whole point of the design (doc 05 §3).
 *
 * When nothing matches, the operation is rejected rather than quietly filed
 * somewhere. The device holds it as needing attention and the worker can see
 * that a check they recorded has nowhere to go, which is a real thing for an
 * admin to fix. Silently inventing a window would hide a schedule that does
 * not cover when care is actually being given.
 */
async function bindWindow(db: Database, participantId: string, recordedAt: Date): Promise<string> {
  const [containing] = await db
    .select({ id: checkWindows.id })
    .from(checkWindows)
    .where(
      and(
        eq(checkWindows.participantId, participantId),
        lte(checkWindows.startsAt, recordedAt),
        gt(checkWindows.endsAt, recordedAt),
      ),
    )
    .limit(1);
  if (containing) return containing.id;

  throw new HttpError(
    'not_found',
    'There is no check window covering when this was recorded. An admin needs to extend the schedule before it can be saved.',
  );
}
