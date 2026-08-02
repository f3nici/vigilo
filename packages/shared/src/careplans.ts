import { z } from 'zod';
import { renderRichText, richTextHeadings, richTextPlainText } from './richtext.js';

/**
 * Care plans (doc 01 §7.1, doc 03 §9, doc 06 §4.7).
 *
 * A per-participant document of standing instructions, authored by nurses and
 * admins, versioned, with draft and published states. Workers read the
 * published version and the app marks it unread until they open it.
 *
 * The body is source text, never HTML. It is rendered by the shared rich text
 * renderer in `richtext.ts`, which is where the reasoning for that lives (D63)
 * and which check form info blocks use as well.
 */

export const CARE_PLAN_MAX_BODY = 50_000;

/*
 * The renderer used to live here, and these names are what the care plan code
 * calls it by. Kept as aliases rather than renamed at every call site: a nurse
 * previewing a plan and a worker reading one both go through `renderCarePlan`,
 * and that is the name doc 07 §7 and CLAUDE.md both use.
 */
export const renderCarePlan = renderRichText;
export const carePlanHeadings = richTextHeadings;
export const carePlanPlainText = richTextPlainText;
export type { RichTextHeading as CarePlanHeading } from './richtext.js';

/* -------------------------------------------------------------- the plan */

export const carePlanStatuses = ['draft', 'published', 'archived'] as const;
export const carePlanStatusSchema = z.enum(carePlanStatuses);
export type CarePlanStatus = z.infer<typeof carePlanStatusSchema>;

export const carePlanVersionStatuses = ['draft', 'published', 'superseded'] as const;
export const carePlanVersionStatusSchema = z.enum(carePlanVersionStatuses);
export type CarePlanVersionStatus = z.infer<typeof carePlanVersionStatusSchema>;

export const createCarePlanRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().max(CARE_PLAN_MAX_BODY).default(''),
  })
  .strict();

export type CreateCarePlanRequest = z.infer<typeof createCarePlanRequestSchema>;

/** Only a draft version can be edited. A published one is immutable. */
export const updateCarePlanVersionRequestSchema = z
  .object({ body: z.string().max(CARE_PLAN_MAX_BODY) })
  .strict();

export type UpdateCarePlanVersionRequest = z.infer<typeof updateCarePlanVersionRequestSchema>;

export const updateCarePlanRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['published', 'archived']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export type UpdateCarePlanRequest = z.infer<typeof updateCarePlanRequestSchema>;

/**
 * Publishing takes a change summary, and it is required.
 *
 * Every assigned worker is notified and shown an unread marker, so somebody is
 * being asked to read this again. "What changed" is the difference between a
 * worker skimming it and a worker finding the paragraph that matters.
 */
export const publishCarePlanVersionRequestSchema = z
  .object({ changeSummary: z.string().trim().min(1).max(300) })
  .strict();

export type PublishCarePlanVersionRequest = z.infer<typeof publishCarePlanVersionRequestSchema>;

export const carePlanVersionSchema = z.object({
  id: z.string(),
  carePlanId: z.string(),
  participantId: z.string(),
  version: z.number(),
  /** The author's source. Render it with `renderCarePlan`, never with `v-html` raw. */
  body: z.string(),
  status: carePlanVersionStatusSchema,
  changeSummary: z.string().nullable(),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedByName: z.string().nullable(),
  createdAt: z.string(),
});

export type CarePlanVersion = z.infer<typeof carePlanVersionSchema>;

export const carePlanSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  title: z.string(),
  status: carePlanStatusSchema,
  currentVersionId: z.string().nullable(),
  /** The published version's number, for "version 4" on screen. */
  currentVersion: z.number().nullable(),
  publishedAt: z.string().nullable(),
  changeSummary: z.string().nullable(),
  /** The published body, so a device holds one row per plan and can render it. */
  body: z.string().nullable(),
  /** True when this reader has not opened the current version (doc 01 §7.1). */
  unread: z.boolean(),
  /** Set only for an author: there is a draft waiting to be published. */
  hasDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CarePlan = z.infer<typeof carePlanSchema>;

/**
 * A read receipt, sent up when a worker opens the plan.
 *
 * The id is generated on the device like every other record it creates, so a
 * receipt queued with no signal is idempotent when it finally sends.
 */
export const markCarePlanReadRequestSchema = z
  .object({
    id: z.string().uuid(),
    readAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MarkCarePlanReadRequest = z.infer<typeof markCarePlanReadRequestSchema>;

export function describeCarePlanStatus(status: CarePlanStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft, not yet published';
    case 'published':
      return 'Published';
    case 'archived':
      return 'Archived';
  }
}
