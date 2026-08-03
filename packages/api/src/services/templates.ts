import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  buildCheckFormExport,
  diffTemplateSchemas,
  templateSchemaSchema,
  uniqueFormName,
  validateAgainstPublished,
  validateTemplateSchema,
  type CheckFormDocument,
  type CheckFormExport,
  type CheckTemplate,
  type CreateTemplateRequest,
  type FieldType,
  type ImportCheckFormsRequest,
  type ImportedForm,
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
  participantCheckForms,
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

export function toVersion(
  row: CheckTemplateVersionRow,
  publishedByName: string | null,
): TemplateVersion {
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

/**
 * The forms a worker can record on demand for this participant (D89, D94).
 *
 * Every active template with a published version that is either ticked for
 * this person or already scheduled for them. Not the admin template list: that
 * one carries draft state, version counts, schedule counts and publication
 * history, none of which helps somebody choosing what to fill in.
 *
 * The schedule half of that union is not a convenience. A form an admin put on
 * this participant's schedule is unarguably theirs, and leaving it out of the
 * picker would mean a worker could fill in a window for a form they cannot
 * record on demand, which is a distinction nobody can see the reason for.
 *
 * A retired template is left out. It is still bound to every entry recorded
 * against it, so history reads correctly, but it is not something to start a
 * new record with.
 */
export async function listRecordableForms(
  db: Database,
  participantId: string,
): Promise<{ id: string; name: string; description: string | null }[]> {
  return db
    .selectDistinct({
      id: checkTemplates.id,
      name: checkTemplates.name,
      description: checkTemplates.description,
    })
    .from(checkTemplates)
    .innerJoin(
      checkTemplateVersions,
      and(
        eq(checkTemplateVersions.templateId, checkTemplates.id),
        eq(checkTemplateVersions.status, 'published'),
      ),
    )
    .where(
      and(
        eq(checkTemplates.status, 'active'),
        or(
          inArray(
            checkTemplates.id,
            db
              .select({ id: participantCheckForms.templateId })
              .from(participantCheckForms)
              .where(eq(participantCheckForms.participantId, participantId)),
          ),
          inArray(
            checkTemplates.id,
            db
              .select({ id: checkSchedules.templateId })
              .from(checkSchedules)
              .where(
                and(
                  eq(checkSchedules.participantId, participantId),
                  eq(checkSchedules.status, 'active'),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(checkTemplates.name));
}

/**
 * The tick list an admin edits: every active form, and whether it is on for
 * this participant.
 *
 * Unpublished forms are in the list. An admin setting a person up should be
 * able to tick a form that is still being written, rather than having to come
 * back after publishing it. `recordable` says which ones a worker can actually
 * pick today, so the screen can explain the difference instead of hiding it.
 */
export async function listParticipantFormChoices(
  db: Database,
  participantId: string,
): Promise<
  { id: string; name: string; description: string | null; assigned: boolean; recordable: boolean }[]
> {
  const [templates, assigned, scheduled] = await Promise.all([
    db
      .select({
        id: checkTemplates.id,
        name: checkTemplates.name,
        description: checkTemplates.description,
        publishedVersions: sql<number>`count(${checkTemplateVersions.id}) filter (where ${checkTemplateVersions.status} = 'published')`,
      })
      .from(checkTemplates)
      .leftJoin(checkTemplateVersions, eq(checkTemplateVersions.templateId, checkTemplates.id))
      .where(eq(checkTemplates.status, 'active'))
      .groupBy(checkTemplates.id)
      .orderBy(asc(checkTemplates.name)),
    db
      .select({ templateId: participantCheckForms.templateId })
      .from(participantCheckForms)
      .where(eq(participantCheckForms.participantId, participantId)),
    db
      .select({ templateId: checkSchedules.templateId })
      .from(checkSchedules)
      .where(
        and(eq(checkSchedules.participantId, participantId), eq(checkSchedules.status, 'active')),
      ),
  ]);

  const ticked = new Set(assigned.map((row) => row.templateId));
  const onSchedule = new Set(scheduled.map((row) => row.templateId));

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    assigned: ticked.has(template.id) || onSchedule.has(template.id),
    recordable: Number(template.publishedVersions) > 0,
  }));
}

/**
 * Replaces the tick list in one go.
 *
 * The whole set rather than one row at a time, because the screen is a set of
 * checkboxes and a save: sending adds and removes separately would let a
 * dropped request leave the two halves disagreeing.
 *
 * A form that is on this participant's schedule is not stored here. It is
 * already theirs by a stronger route, and writing a row for it would leave a
 * tick that survives the schedule being retired.
 */
export async function setParticipantForms(
  db: Database,
  participantId: string,
  templateIds: string[],
  actor: AuditActor,
  assignedBy: string | null,
): Promise<void> {
  const active =
    templateIds.length === 0
      ? []
      : await db
          .select({ id: checkTemplates.id })
          .from(checkTemplates)
          .where(and(eq(checkTemplates.status, 'active'), inArray(checkTemplates.id, templateIds)));

  if (active.length !== new Set(templateIds).size) {
    throw new HttpError('validation_failed', 'One of those forms does not exist any more.');
  }

  const scheduled = await db
    .select({ templateId: checkSchedules.templateId })
    .from(checkSchedules)
    .where(
      and(eq(checkSchedules.participantId, participantId), eq(checkSchedules.status, 'active')),
    );
  const onSchedule = new Set(scheduled.map((row) => row.templateId));
  const toStore = [...new Set(templateIds)].filter((id) => !onSchedule.has(id));

  await db.transaction(async (tx) => {
    await tx
      .delete(participantCheckForms)
      .where(eq(participantCheckForms.participantId, participantId));

    if (toStore.length > 0) {
      await tx
        .insert(participantCheckForms)
        .values(toStore.map((templateId) => ({ participantId, templateId, assignedBy })));
    }
  });

  await recordAudit(db, {
    actor,
    action: 'participant_forms_set',
    entityType: 'participant',
    entityId: participantId,
    metadata: { templateIds: toStore, scheduled: [...onSchedule] },
  });
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

/* ------------------------------------------------------- export and import */

/**
 * The forms as a portable document (D91).
 *
 * The published version is what travels, because that is the form the team
 * actually uses. A template that has never been published falls back to its
 * draft, so a form somebody is halfway through building can still be moved to
 * another box to finish, and one with neither is skipped rather than exported
 * as an empty shell.
 */
export async function exportTemplates(
  db: Database,
  templateIds: string[] | 'all',
  actor: AuditActor,
): Promise<CheckFormExport> {
  const rows = await db
    .select()
    .from(checkTemplates)
    .where(
      templateIds === 'all'
        ? eq(checkTemplates.status, 'active')
        : inArray(checkTemplates.id, templateIds),
    )
    .orderBy(asc(checkTemplates.name));

  if (templateIds !== 'all' && rows.length !== templateIds.length) {
    throw new HttpError('not_found', 'One of those check forms does not exist.');
  }

  const versions = await versionsOf(
    db,
    rows.map((row) => row.id),
  );

  const forms: CheckFormDocument[] = [];
  for (const row of rows) {
    const all = versions.get(row.id)?.rows ?? [];
    const source =
      all.find((one) => one.status === 'published') ?? all.find((one) => one.status === 'draft');
    if (!source) continue;

    forms.push({ name: row.name, description: row.description, schema: parseSchema(source) });
  }

  if (forms.length === 0) {
    throw new HttpError(
      'validation_failed',
      'There is nothing to export yet. Build a check form first.',
    );
  }

  await recordAudit(db, {
    action: 'template.export',
    actor,
    entityType: 'check_template',
    entityId: null,
    metadata: { formCount: forms.length, names: forms.map((form) => form.name) },
  });

  return buildCheckFormExport(forms, new Date());
}

/**
 * Creates a form per document in the file, always as an unpublished draft.
 *
 * Never an update to an existing form, even when the names match. A published
 * version has entries bound to it and an import is a file somebody dropped on a
 * screen: those two facts must never meet. A colliding name is marked instead,
 * so importing the same file twice is untidy rather than destructive.
 *
 * The whole file lands or none of it does. Half an import is worse than a
 * failed one, because the admin has to work out which half.
 */
export async function importTemplates(
  db: Database,
  request: ImportCheckFormsRequest,
  createdBy: string,
  actor: AuditActor,
): Promise<ImportedForm[]> {
  const existing = await db.select({ name: checkTemplates.name }).from(checkTemplates);
  const taken = new Set(existing.map((row) => row.name));

  const imported = await db.transaction(async (tx) => {
    const created: ImportedForm[] = [];

    for (const form of request.forms) {
      const name = uniqueFormName(form.name, taken);
      taken.add(name);

      const [template] = await tx
        .insert(checkTemplates)
        .values({ name, description: form.description, createdBy })
        .returning();

      await tx.insert(checkTemplateVersions).values({
        templateId: template!.id,
        version: 1,
        schema: form.schema,
        status: 'draft',
      });

      created.push({
        id: template!.id,
        name,
        originalName: form.name,
        fieldCount: form.schema.fields.length,
      });
    }

    return created;
  });

  await recordAudit(db, {
    action: 'template.import',
    actor,
    entityType: 'check_template',
    entityId: null,
    metadata: {
      formCount: imported.length,
      names: imported.map((form) => form.name),
      renamed: imported.filter((form) => form.name !== form.originalName).length,
    },
  });

  return imported;
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

  /*
   * Two active forms with the same name is a schedule pointed at the wrong one.
   * An import goes out of its way to avoid that by marking a collision (D91),
   * and a rename must not be the way back into it. Retired forms are left out:
   * they cannot be scheduled, and a name freed by retiring one is a name worth
   * reusing.
   */
  if (request.name !== undefined && request.name !== row.name) {
    const [clash] = await db
      .select({ id: checkTemplates.id })
      .from(checkTemplates)
      .where(
        and(
          eq(checkTemplates.name, request.name),
          eq(checkTemplates.status, 'active'),
          ne(checkTemplates.id, id),
        ),
      )
      .limit(1);

    if (clash) {
      throw new HttpError('conflict', 'Another check form is already called that.');
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
