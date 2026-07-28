import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  diffTemplateSchemas,
  templateSchemaSchema,
  validateAgainstPublished,
  validateTemplateSchema,
  type CheckTemplate,
  type CreateTemplateRequest,
  type FieldType,
  type PublishPreview,
  type TemplateSchema,
  type TemplateVersion,
  type UpdateTemplateRequest,
} from '@vigilo/shared';
import type { Database } from '../db/client.js';
import {
  checkSchedules,
  checkTemplates,
  checkTemplateVersions,
  users,
  type CheckTemplateRow,
  type CheckTemplateVersionRow,
} from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit.js';
import { HttpError } from '../middleware/errors.js';

/**
 * Check templates and their versions (doc 03 §4, doc 04 §5).
 *
 * The rule everything here exists to protect: **a published version never
 * changes.** Entries point at a version, not a template, so February's records
 * keep rendering with February's fields no matter what March does. Editing is
 * only ever possible on a draft, and publishing supersedes rather than
 * overwrites.
 *
 * A template holds at most one draft at a time. Two drafts would mean two
 * answers to "what is being worked on", and the field builder would have to ask
 * which one, for no benefit.
 */

const EMPTY_SCHEMA: TemplateSchema = { fields: [] };

function parseSchema(row: CheckTemplateVersionRow): TemplateSchema {
  const parsed = templateSchemaSchema.safeParse(row.schema);
  if (!parsed.success) {
    // A stored schema that no longer parses means the field rules changed under
    // rows that were already published. That is a migration problem, not a
    // request problem, and guessing at it would render a form wrong.
    throw new HttpError(
      'server_error',
      'This check form was saved in a format this version cannot read.',
    );
  }
  return parsed.data;
}

function toVersion(row: CheckTemplateVersionRow, publishedByName: string | null): TemplateVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    version: row.version,
    status: row.status,
    schema: parseSchema(row),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

async function versionsOf(
  db: Database,
  templateIds: string[],
): Promise<Map<string, { rows: CheckTemplateVersionRow[]; names: Map<string, string> }>> {
  if (templateIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(checkTemplateVersions)
    .where(inArray(checkTemplateVersions.templateId, templateIds))
    .orderBy(desc(checkTemplateVersions.version));

  const publisherIds = [...new Set(rows.map((row) => row.publishedBy).filter((id) => id !== null))];
  const names = new Map<string, string>();
  if (publisherIds.length > 0) {
    const publishers = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, publisherIds));
    for (const publisher of publishers) names.set(publisher.id, publisher.displayName);
  }

  const grouped = new Map<
    string,
    { rows: CheckTemplateVersionRow[]; names: Map<string, string> }
  >();
  for (const row of rows) {
    const bucket = grouped.get(row.templateId) ?? { rows: [], names };
    bucket.rows.push(row);
    grouped.set(row.templateId, bucket);
  }
  return grouped;
}

async function scheduleCounts(db: Database, templateIds: string[]): Promise<Map<string, number>> {
  if (templateIds.length === 0) return new Map();

  const rows = await db
    .select({ templateId: checkSchedules.templateId, count: sql<string>`count(*)::text` })
    .from(checkSchedules)
    .where(
      and(
        inArray(checkSchedules.templateId, templateIds),
        inArray(checkSchedules.status, ['active', 'paused']),
      ),
    )
    .groupBy(checkSchedules.templateId);

  return new Map(rows.map((row) => [row.templateId, Number(row.count)]));
}

function assemble(
  row: CheckTemplateRow,
  versions: { rows: CheckTemplateVersionRow[]; names: Map<string, string> } | undefined,
  scheduleCount: number,
): CheckTemplate {
  const all = versions?.rows ?? [];
  const names = versions?.names ?? new Map<string, string>();
  const published = all.find((one) => one.status === 'published') ?? null;
  const draft = all.find((one) => one.status === 'draft') ?? null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    publishedVersion: published
      ? toVersion(
          published,
          published.publishedBy ? (names.get(published.publishedBy) ?? null) : null,
        )
      : null,
    draftVersion: draft ? toVersion(draft, null) : null,
    versionCount: all.length,
    scheduleCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTemplates(
  db: Database,
  options: { includeRetired?: boolean } = {},
): Promise<CheckTemplate[]> {
  const rows = await db
    .select()
    .from(checkTemplates)
    .where(options.includeRetired ? undefined : eq(checkTemplates.status, 'active'))
    .orderBy(asc(checkTemplates.name));

  const ids = rows.map((row) => row.id);
  const [versions, counts] = await Promise.all([versionsOf(db, ids), scheduleCounts(db, ids)]);

  return rows.map((row) => assemble(row, versions.get(row.id), counts.get(row.id) ?? 0));
}

export async function getTemplate(db: Database, id: string): Promise<CheckTemplate> {
  const [row] = await db.select().from(checkTemplates).where(eq(checkTemplates.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That check form does not exist.');

  const [versions, counts] = await Promise.all([versionsOf(db, [id]), scheduleCounts(db, [id])]);
  return assemble(row, versions.get(id), counts.get(id) ?? 0);
}

export async function findVersion(db: Database, id: string): Promise<CheckTemplateVersionRow> {
  const [row] = await db
    .select()
    .from(checkTemplateVersions)
    .where(eq(checkTemplateVersions.id, id))
    .limit(1);
  if (!row) throw new HttpError('not_found', 'That version of the check form does not exist.');
  return row;
}

export async function getVersion(db: Database, id: string): Promise<TemplateVersion> {
  const row = await findVersion(db, id);
  let publishedByName: string | null = null;
  if (row.publishedBy) {
    const [publisher] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.publishedBy))
      .limit(1);
    publishedByName = publisher?.displayName ?? null;
  }
  return toVersion(row, publishedByName);
}

export async function listVersions(db: Database, templateId: string): Promise<TemplateVersion[]> {
  const versions = await versionsOf(db, [templateId]);
  const bucket = versions.get(templateId);
  if (!bucket) return [];
  return bucket.rows.map((row) =>
    toVersion(row, row.publishedBy ? (bucket.names.get(row.publishedBy) ?? null) : null),
  );
}

/** The published version a schedule resolves to when it materialises a window. */
export async function publishedVersionFor(
  db: Database,
  templateId: string,
): Promise<CheckTemplateVersionRow | null> {
  const [row] = await db
    .select()
    .from(checkTemplateVersions)
    .where(
      and(
        eq(checkTemplateVersions.templateId, templateId),
        eq(checkTemplateVersions.status, 'published'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createTemplate(
  db: Database,
  request: CreateTemplateRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<CheckTemplate> {
  const created = await db.transaction(async (tx) => {
    const [template] = await tx
      .insert(checkTemplates)
      .values({
        name: request.name,
        description: request.description ?? null,
        createdBy,
      })
      .returning();

    // A new template starts with an empty draft, so the field builder always
    // has something to open rather than a special "no version yet" state.
    await tx.insert(checkTemplateVersions).values({
      templateId: template!.id,
      version: 1,
      schema: EMPTY_SCHEMA,
      status: 'draft',
    });

    return template!;
  });

  await recordAudit(db, {
    action: 'template.create',
    actor,
    entityType: 'check_template',
    entityId: created.id,
  });

  return getTemplate(db, created.id);
}

export async function updateTemplate(
  db: Database,
  id: string,
  request: UpdateTemplateRequest,
  actor: AuditActor,
): Promise<CheckTemplate> {
  const [row] = await db.select().from(checkTemplates).where(eq(checkTemplates.id, id)).limit(1);
  if (!row) throw new HttpError('not_found', 'That check form does not exist.');

  if (request.status === 'retired') {
    const counts = await scheduleCounts(db, [id]);
    if ((counts.get(id) ?? 0) > 0) {
      throw new HttpError(
        'conflict',
        'Schedules are still using this check form. End those schedules first.',
      );
    }
  }

  const changes: Partial<typeof checkTemplates.$inferInsert> = { updatedAt: new Date() };
  if (request.name !== undefined) changes.name = request.name;
  if ('description' in request) changes.description = request.description ?? null;
  if (request.status !== undefined) changes.status = request.status;

  await db.update(checkTemplates).set(changes).where(eq(checkTemplates.id, id));

  await recordAudit(db, {
    action: 'template.update',
    actor,
    entityType: 'check_template',
    entityId: id,
    metadata: { fields: Object.keys(request).sort() },
  });

  return getTemplate(db, id);
}

/**
 * Starts a draft from the current published version, so an admin edits a copy
 * of what staff are using rather than building the form again.
 */
export async function createDraftVersion(
  db: Database,
  templateId: string,
  actor: AuditActor,
): Promise<TemplateVersion> {
  const created = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(checkTemplateVersions)
      .where(eq(checkTemplateVersions.templateId, templateId))
      .orderBy(desc(checkTemplateVersions.version));

    if (existing.length === 0) {
      throw new HttpError('not_found', 'That check form does not exist.');
    }

    const draft = existing.find((one) => one.status === 'draft');
    if (draft) {
      // Already one open. Handing it back beats creating a second draft that
      // silently competes with it.
      return draft;
    }

    const published = existing.find((one) => one.status === 'published');
    const [row] = await tx
      .insert(checkTemplateVersions)
      .values({
        templateId,
        version: (existing[0]?.version ?? 0) + 1,
        schema: published?.schema ?? EMPTY_SCHEMA,
        status: 'draft',
      })
      .returning();

    return row!;
  });

  await recordAudit(db, {
    action: 'template.draft',
    actor,
    entityType: 'check_template_version',
    entityId: created.id,
    metadata: { version: created.version },
  });

  return toVersion(created, null);
}

export async function updateDraftSchema(
  db: Database,
  versionId: string,
  schema: TemplateSchema,
  actor: AuditActor,
): Promise<TemplateVersion> {
  const row = await findVersion(db, versionId);

  // The immutability rule, and the only place it is enforced.
  if (row.status !== 'draft') {
    throw new HttpError(
      'conflict',
      'This version is published and cannot be changed. Start a new version instead.',
    );
  }

  const [updated] = await db
    .update(checkTemplateVersions)
    .set({ schema })
    .where(eq(checkTemplateVersions.id, versionId))
    .returning();

  await recordAudit(db, {
    action: 'template.draft_update',
    actor,
    entityType: 'check_template_version',
    entityId: versionId,
    // Field keys are structure. What a field is called is not clinical data,
    // and knowing which fields moved is the point of the entry.
    metadata: { fieldCount: schema.fields.length },
  });

  return toVersion(updated!, null);
}

/** Every published key and the type it was published as, across all versions. */
async function publishedFieldTypes(
  db: Database,
  templateId: string,
): Promise<Map<string, FieldType>> {
  const rows = await db
    .select()
    .from(checkTemplateVersions)
    .where(
      and(
        eq(checkTemplateVersions.templateId, templateId),
        inArray(checkTemplateVersions.status, ['published', 'superseded']),
      ),
    )
    .orderBy(asc(checkTemplateVersions.version));

  const types = new Map<string, FieldType>();
  for (const row of rows) {
    for (const field of parseSchema(row).fields) {
      if (!types.has(field.key)) types.set(field.key, field.type);
    }
  }
  return types;
}

/** What publishing would change, and anything blocking it (doc 06 §5). */
export async function previewPublish(db: Database, versionId: string): Promise<PublishPreview> {
  const row = await findVersion(db, versionId);
  const schema = parseSchema(row);
  const published = await publishedVersionFor(db, row.templateId);

  return {
    diff: diffTemplateSchemas(published ? parseSchema(published) : null, schema),
    problems: [
      ...validateTemplateSchema(schema),
      ...validateAgainstPublished(schema, await publishedFieldTypes(db, row.templateId)),
    ],
  };
}

/**
 * Publishing is irreversible (CLAUDE.md). The previous published version is
 * superseded rather than deleted, because every entry recorded against it still
 * needs its field set to render.
 */
export async function publishVersion(
  db: Database,
  versionId: string,
  publishedBy: string,
  actor: AuditActor,
): Promise<TemplateVersion> {
  const preview = await previewPublish(db, versionId);
  if (preview.problems.length > 0) {
    throw new HttpError('validation_failed', preview.problems[0]!.message, {
      problems: preview.problems,
    });
  }

  const published = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(checkTemplateVersions)
      .where(eq(checkTemplateVersions.id, versionId))
      .limit(1);

    if (!row) throw new HttpError('not_found', 'That version does not exist.');
    if (row.status !== 'draft') {
      throw new HttpError('conflict', 'That version has already been published.');
    }

    await tx
      .update(checkTemplateVersions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(checkTemplateVersions.templateId, row.templateId),
          eq(checkTemplateVersions.status, 'published'),
        ),
      );

    const [updated] = await tx
      .update(checkTemplateVersions)
      .set({ status: 'published', publishedAt: new Date(), publishedBy })
      .where(eq(checkTemplateVersions.id, versionId))
      .returning();

    await tx
      .update(checkTemplates)
      .set({ updatedAt: new Date() })
      .where(eq(checkTemplates.id, row.templateId));

    return updated!;
  });

  await recordAudit(db, {
    action: 'template.publish',
    actor,
    entityType: 'check_template_version',
    entityId: versionId,
    metadata: {
      version: published.version,
      added: preview.diff.added.length,
      removed: preview.diff.removed.length,
      relabelled: preview.diff.relabelled.length,
    },
  });

  return toVersion(published, null);
}

export { parseSchema };
