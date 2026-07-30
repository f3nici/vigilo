import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type CarePlan,
  type CarePlanVersion,
  type CreateCarePlanRequest,
  type MarkCarePlanReadRequest,
  type PublishCarePlanVersionRequest,
  type Role,
  type UpdateCarePlanRequest,
  type UpdateCarePlanVersionRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  carePlanReads,
  carePlanVersions,
  carePlans,
  users,
  type CarePlanRow,
  type CarePlanVersionRow,
} from '../db/schema.js';
import type { KeyRing } from '../crypto/keys.js';
import { decryptOptional, encryptOptional } from '../crypto/fields.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Care plans (doc 01 §7.1, doc 04 §10).
 *
 * Versioned like check templates, and for the same reason: a plan that changes
 * in March must not rewrite what March's record said the instructions were. A
 * published version is immutable, a new draft supersedes it on publish, and
 * every assigned worker is notified and shown an unread marker until they open
 * it.
 *
 * The body is the author's source text, never HTML. Rendering happens in
 * `packages/shared/careplans.ts`, on both sides, from one function (D63).
 */

export const BODY_COLUMN = 'care_plan_versions.body_enc';

export type CarePlanPrincipal = {
  userId: string;
  role: Role;
};

/* ------------------------------------------------------------------ reading */

function bodyOf(keyRing: KeyRing, row: CarePlanVersionRow | undefined): string {
  if (!row) return '';
  return decryptOptional(keyRing, BODY_COLUMN, row.bodyEnc) ?? '';
}

async function versionsOf(
  db: Database,
  planIds: readonly string[],
): Promise<Map<string, CarePlanVersionRow[]>> {
  const byPlan = new Map<string, CarePlanVersionRow[]>();
  if (planIds.length === 0) return byPlan;

  const rows = await db
    .select()
    .from(carePlanVersions)
    .where(inArray(carePlanVersions.carePlanId, [...planIds]))
    .orderBy(desc(carePlanVersions.version));

  for (const row of rows) {
    const bucket = byPlan.get(row.carePlanId) ?? [];
    bucket.push(row);
    byPlan.set(row.carePlanId, bucket);
  }
  return byPlan;
}

/** Which current versions this reader has already opened. */
async function readVersionIds(
  db: Database,
  userId: string,
  versionIds: readonly string[],
): Promise<Set<string>> {
  if (versionIds.length === 0) return new Set();
  const rows = await db
    .select({ carePlanVersionId: carePlanReads.carePlanVersionId })
    .from(carePlanReads)
    .where(
      and(
        eq(carePlanReads.userId, userId),
        inArray(carePlanReads.carePlanVersionId, [...versionIds]),
      ),
    );
  return new Set(rows.map((row) => row.carePlanVersionId));
}

async function toCarePlans(
  db: Database,
  keyRing: KeyRing,
  rows: readonly CarePlanRow[],
  principal: CarePlanPrincipal,
): Promise<CarePlan[]> {
  if (rows.length === 0) return [];

  const versions = await versionsOf(
    db,
    rows.map((row) => row.id),
  );

  const currentIds = rows
    .map((row) => row.currentVersionId)
    .filter((id): id is string => id !== null);
  const read = await readVersionIds(db, principal.userId, currentIds);

  return rows.map((row) => {
    const all = versions.get(row.id) ?? [];
    const current = all.find((one) => one.id === row.currentVersionId);
    const draft = all.find((one) => one.status === 'draft');

    return {
      id: row.id,
      participantId: row.participantId,
      title: row.title,
      status: row.status,
      currentVersionId: row.currentVersionId,
      currentVersion: current?.version ?? null,
      publishedAt: current?.publishedAt?.toISOString() ?? null,
      changeSummary: current?.changeSummary ?? null,
      body: current ? bodyOf(keyRing, current) : null,
      /*
       * Unread only once there is something published to read. A plan still in
       * draft is not something a worker has failed to open.
       */
      unread: row.currentVersionId !== null && !read.has(row.currentVersionId),
      hasDraft: draft !== undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function listCarePlans(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  principal: CarePlanPrincipal,
  options: { includeArchived?: boolean } = {},
): Promise<CarePlan[]> {
  const filters = [eq(carePlans.participantId, participantId)];
  if (!options.includeArchived) {
    filters.push(sql`${carePlans.status} <> 'archived'`);
  }

  const rows = await db
    .select()
    .from(carePlans)
    .where(and(...filters))
    .orderBy(asc(carePlans.title));

  return toCarePlans(db, keyRing, rows, principal);
}

/** By id, for a sync page. Same DTO the screens render. */
export async function carePlansByIds(
  db: Database,
  keyRing: KeyRing,
  ids: readonly string[],
  principal: CarePlanPrincipal,
): Promise<CarePlan[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(carePlans)
    .where(inArray(carePlans.id, [...ids]));
  return toCarePlans(db, keyRing, rows, principal);
}

export async function findCarePlanRow(db: Database, id: string): Promise<CarePlanRow> {
  const [row] = await db.select().from(carePlans).where(eq(carePlans.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That care plan does not exist.');
  return row;
}

export async function getCarePlan(
  db: Database,
  keyRing: KeyRing,
  id: string,
  principal: CarePlanPrincipal,
): Promise<CarePlan> {
  const row = await findCarePlanRow(db, id);
  const [plan] = await toCarePlans(db, keyRing, [row], principal);
  return plan!;
}

/**
 * Every version, newest first (doc 06 §4.7 asks for a version history).
 *
 * Authors only. A worker reads the plan that applies now; the history of what
 * it used to say is an editorial record, not a care instruction.
 */
export async function listCarePlanVersions(
  db: Database,
  keyRing: KeyRing,
  carePlanId: string,
): Promise<CarePlanVersion[]> {
  const plan = await findCarePlanRow(db, carePlanId);

  const rows = await db
    .select({ version: carePlanVersions, publishedByName: users.displayName })
    .from(carePlanVersions)
    .leftJoin(users, eq(users.id, carePlanVersions.publishedBy))
    .where(eq(carePlanVersions.carePlanId, carePlanId))
    .orderBy(desc(carePlanVersions.version));

  return rows.map(({ version, publishedByName }) => ({
    id: version.id,
    carePlanId: version.carePlanId,
    participantId: plan.participantId,
    version: version.version,
    body: bodyOf(keyRing, version),
    status: version.status,
    changeSummary: version.changeSummary,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    publishedBy: version.publishedBy,
    publishedByName,
    createdAt: version.createdAt.toISOString(),
  }));
}

export async function findVersionRow(db: Database, id: string): Promise<CarePlanVersionRow> {
  const [row] = await db
    .select()
    .from(carePlanVersions)
    .where(eq(carePlanVersions.id, id))
    .limit(1);
  if (!row) throw new HttpError('not_found', 'That version of the care plan does not exist.');
  return row;
}

/* ------------------------------------------------------------------ writing */

/**
 * A new plan and its first draft, together.
 *
 * A plan with no version at all would be a row nobody can edit, so the two are
 * created in one transaction.
 */
export async function createCarePlan(
  db: Database,
  keyRing: KeyRing,
  participantId: string,
  request: CreateCarePlanRequest,
  principal: CarePlanPrincipal,
  actor: AuditActor,
): Promise<CarePlan> {
  const planId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(carePlans)
      .values({ participantId, title: request.title, createdBy: principal.userId })
      .returning();

    await tx.insert(carePlanVersions).values({
      carePlanId: plan!.id,
      version: 1,
      bodyEnc: encryptOptional(keyRing, BODY_COLUMN, request.body),
      status: 'draft',
    });

    return plan!.id;
  });

  await recordAudit(db, {
    action: 'care_plan.create',
    actor,
    entityType: 'care_plan',
    entityId: planId,
    participantId,
    // The title, never the body: the body is instructions about a person.
    metadata: { title: request.title },
  });

  return getCarePlan(db, keyRing, planId, principal);
}

export async function updateCarePlan(
  db: Database,
  keyRing: KeyRing,
  id: string,
  request: UpdateCarePlanRequest,
  principal: CarePlanPrincipal,
  actor: AuditActor,
): Promise<CarePlan> {
  const existing = await findCarePlanRow(db, id);

  if (request.status === 'published' && existing.currentVersionId === null) {
    throw new HttpError(
      'conflict',
      'Publish a version first. A plan with nothing published has nothing for a worker to read.',
    );
  }

  const patch: Partial<typeof carePlans.$inferInsert> = { updatedAt: new Date() };
  if (request.title !== undefined) patch.title = request.title;
  if (request.status !== undefined) patch.status = request.status;

  await db.update(carePlans).set(patch).where(eq(carePlans.id, id));

  await recordAudit(db, {
    action: request.status === 'archived' ? 'care_plan.archive' : 'care_plan.update',
    actor,
    entityType: 'care_plan',
    entityId: id,
    participantId: existing.participantId,
    metadata: { fields: Object.keys(request).sort() },
  });

  return getCarePlan(db, keyRing, id, principal);
}

/**
 * The draft to edit, created on demand.
 *
 * A worker asking for the plan gets the published version. An author asking to
 * edit gets the existing draft, or a fresh one copied from what is published,
 * because starting from a blank page is how a paragraph that mattered gets
 * lost.
 */
export async function draftFor(
  db: Database,
  keyRing: KeyRing,
  carePlanId: string,
): Promise<CarePlanVersionRow> {
  const plan = await findCarePlanRow(db, carePlanId);

  const [existing] = await db
    .select()
    .from(carePlanVersions)
    .where(and(eq(carePlanVersions.carePlanId, carePlanId), eq(carePlanVersions.status, 'draft')))
    .limit(1);
  if (existing) return existing;

  const [latest] = await db
    .select()
    .from(carePlanVersions)
    .where(eq(carePlanVersions.carePlanId, carePlanId))
    .orderBy(desc(carePlanVersions.version))
    .limit(1);

  const current =
    plan.currentVersionId === null ? undefined : await findVersionRow(db, plan.currentVersionId);

  const [created] = await db
    .insert(carePlanVersions)
    .values({
      carePlanId,
      version: (latest?.version ?? 0) + 1,
      bodyEnc: encryptOptional(keyRing, BODY_COLUMN, bodyOf(keyRing, current)),
      status: 'draft',
    })
    .returning();

  return created!;
}

/** Only a draft can be edited. A published version is a historical record. */
export async function updateVersion(
  db: Database,
  keyRing: KeyRing,
  versionId: string,
  request: UpdateCarePlanVersionRequest,
  actor: AuditActor,
): Promise<CarePlanVersion[]> {
  const version = await findVersionRow(db, versionId);
  if (version.status !== 'draft') {
    throw new HttpError(
      'conflict',
      'That version is published, so it cannot be changed. Start a new draft instead.',
    );
  }

  const plan = await findCarePlanRow(db, version.carePlanId);

  await db
    .update(carePlanVersions)
    .set({
      bodyEnc: encryptOptional(keyRing, BODY_COLUMN, request.body),
      updatedAt: new Date(),
    })
    .where(eq(carePlanVersions.id, versionId));

  await recordAudit(db, {
    action: 'care_plan.draft_update',
    actor,
    entityType: 'care_plan_version',
    entityId: versionId,
    participantId: plan.participantId,
    // Length, never content. "Somebody rewrote the plan" is auditable without
    // putting the instructions in the log.
    metadata: { version: version.version, bodyLength: request.body.length },
  });

  return listCarePlanVersions(db, keyRing, version.carePlanId);
}

/**
 * Publishing (doc 01 §7.1).
 *
 * The draft becomes the current version, whatever was current becomes
 * superseded, and the plan itself goes published if it was still a draft. Every
 * read receipt for the old version stays where it is, which is what makes the
 * unread marker reappear: nobody has read this one yet.
 */
export async function publishVersion(
  db: Database,
  keyRing: KeyRing,
  versionId: string,
  request: PublishCarePlanVersionRequest,
  principal: CarePlanPrincipal,
  actor: AuditActor,
): Promise<{ plan: CarePlan; participantId: string; carePlanId: string }> {
  const version = await findVersionRow(db, versionId);
  if (version.status !== 'draft') {
    throw new HttpError('conflict', 'That version has already been published.');
  }

  const plan = await findCarePlanRow(db, version.carePlanId);
  const now = new Date();

  await db.transaction(async (tx) => {
    if (plan.currentVersionId !== null) {
      await tx
        .update(carePlanVersions)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(carePlanVersions.id, plan.currentVersionId));
    }

    await tx
      .update(carePlanVersions)
      .set({
        status: 'published',
        changeSummary: request.changeSummary,
        publishedAt: now,
        publishedBy: principal.userId,
        updatedAt: now,
      })
      .where(eq(carePlanVersions.id, versionId));

    await tx
      .update(carePlans)
      .set({ currentVersionId: versionId, status: 'published', updatedAt: now })
      .where(eq(carePlans.id, plan.id));
  });

  await recordAudit(db, {
    action: 'care_plan.publish',
    actor,
    entityType: 'care_plan_version',
    entityId: versionId,
    participantId: plan.participantId,
    metadata: { version: version.version, supersededVersionId: plan.currentVersionId },
  });

  return {
    plan: await getCarePlan(db, keyRing, plan.id, principal),
    participantId: plan.participantId,
    carePlanId: plan.id,
  };
}

/** Discards a draft. Only a draft: nothing published is ever removed. */
export async function discardDraft(
  db: Database,
  versionId: string,
  actor: AuditActor,
): Promise<void> {
  const version = await findVersionRow(db, versionId);
  if (version.status !== 'draft') {
    throw new HttpError('conflict', 'A published version is part of the record and stays.');
  }

  const plan = await findCarePlanRow(db, version.carePlanId);
  await db.delete(carePlanVersions).where(eq(carePlanVersions.id, versionId));

  await recordAudit(db, {
    action: 'care_plan.draft_discard',
    actor,
    entityType: 'care_plan_version',
    entityId: versionId,
    participantId: plan.participantId,
    metadata: { version: version.version },
  });
}

/**
 * A read receipt (doc 01 §7.1).
 *
 * Idempotent twice over: by the device-generated id, and by the
 * `(version, user)` unique key. A worker who opens the plan four times has read
 * it once, and a receipt queued offline can be replayed safely.
 */
export async function markRead(
  db: Database,
  carePlanId: string,
  request: MarkCarePlanReadRequest,
  principal: CarePlanPrincipal,
  actor: AuditActor,
): Promise<{ versionId: string | null }> {
  const plan = await findCarePlanRow(db, carePlanId);
  if (plan.currentVersionId === null) return { versionId: null };

  await db
    .insert(carePlanReads)
    .values({
      id: request.id,
      carePlanVersionId: plan.currentVersionId,
      userId: principal.userId,
      readAt: new Date(request.readAt),
    })
    .onConflictDoNothing();

  /*
   * Audited as a view, not as a write. Doc 07 §4: views are logged as well as
   * writes, and "who has read this participant's care plan" is exactly the
   * question an access review asks.
   */
  await recordAudit(db, {
    action: 'care_plan.read',
    actor,
    entityType: 'care_plan_version',
    entityId: plan.currentVersionId,
    participantId: plan.participantId,
    metadata: { carePlanId },
  });

  return { versionId: plan.currentVersionId };
}

/** Who has and has not opened the current version. For an author's screen. */
export async function readReceipts(
  db: Database,
  carePlanId: string,
): Promise<{ userId: string; displayName: string; readAt: string }[]> {
  const plan = await findCarePlanRow(db, carePlanId);
  if (plan.currentVersionId === null) return [];

  const rows = await db
    .select({
      userId: carePlanReads.userId,
      displayName: users.displayName,
      readAt: carePlanReads.readAt,
    })
    .from(carePlanReads)
    .innerJoin(users, eq(users.id, carePlanReads.userId))
    .where(eq(carePlanReads.carePlanVersionId, plan.currentVersionId))
    .orderBy(asc(carePlanReads.readAt));

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    readAt: row.readAt.toISOString(),
  }));
}

/** Plans with something published and unread, for the participant screen badge. */
export async function unreadCarePlanCount(
  db: Database,
  participantIds: readonly string[],
  userId: string,
): Promise<number> {
  if (participantIds.length === 0) return 0;

  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(carePlans)
    .where(
      and(
        inArray(carePlans.participantId, [...participantIds]),
        eq(carePlans.status, 'published'),
        sql`${carePlans.currentVersionId} is not null`,
        sql`not exists (
          select 1 from care_plan_reads
          where care_plan_reads.care_plan_version_id = ${carePlans.currentVersionId}
            and care_plan_reads.user_id = ${userId}
        )`,
      ),
    );

  return Number(row?.count ?? 0);
}
