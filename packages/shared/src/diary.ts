import { z } from 'zod';

/**
 * The diary (doc 01 §6, doc 03 §7, doc 04 §8).
 *
 * Free text about a person's day, filed under an admin-defined category. Three
 * things make it more than a notes field:
 *
 * - **`occurredAt` is separate from `recordedAt`.** A worker writes up the
 *   morning at lunchtime, and the record has to say when it happened rather
 *   than when someone got a moment to type it.
 * - **Visibility is staff-controlled and per entry.** Default visible, because
 *   a record about a person that they cannot read is the exception and should
 *   look like one.
 * - **Editing preserves the original.** Same rule as a check entry: the current
 *   text displays, the history is one tap away, and neither can be removed.
 */

const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Long enough for a shift's worth of narrative, short enough to bound a row. */
export const DIARY_BODY_MAX = 10_000;

export const diaryBodySchema = z.string().trim().min(1).max(DIARY_BODY_MAX);

/**
 * Categories, from doc 01 §6. Admin-configurable, so these are seeded rather
 * than an enum: an organisation's vocabulary is not the developer's to fix.
 */
export const diaryCategoryColours = [
  'lavender',
  'sky',
  'teal',
  'sage',
  'sand',
  'peach',
  'rose',
  'slate',
] as const;

export const diaryCategoryColourSchema = z.enum(diaryCategoryColours);
export type DiaryCategoryColour = z.infer<typeof diaryCategoryColourSchema>;

export const diaryCategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
  colour: diaryCategoryColourSchema,
  sortOrder: z.number(),
  active: z.boolean(),
});

export type DiaryCategory = z.infer<typeof diaryCategorySchema>;

export const createDiaryCategoryRequestSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower case letters, numbers and underscores.'),
    label: z.string().trim().min(1).max(60),
    colour: diaryCategoryColourSchema,
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export type CreateDiaryCategoryRequest = z.infer<typeof createDiaryCategoryRequestSchema>;

/**
 * A slug from a label, so an admin types "Family contact" and never sees a
 * key. The slug is the stable identity across a relabelling, which is why it
 * is derived once at creation and not kept in step with the label afterwards.
 */
export function suggestCategorySlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(slug) ? slug : `category_${slug}`.slice(0, 40);
}

export const updateDiaryCategoryRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    colour: diaryCategoryColourSchema.optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type UpdateDiaryCategoryRequest = z.infer<typeof updateDiaryCategoryRequestSchema>;

/**
 * How far back and forward `occurredAt` may sit.
 *
 * Forward is a small clock-skew allowance rather than a real window: a device
 * that is four minutes fast should not be refused, and a diary entry about
 * something that has not happened yet is not a thing. Backward is generous,
 * because catching up a week of paper notes is a real day at work, and the
 * entry carries `recordedAt` alongside so nothing is disguised.
 */
export const OCCURRED_AT_SKEW_MINUTES = 15;
export const OCCURRED_AT_MAX_PAST_DAYS = 90;

export function occurredAtProblem(occurredAt: Date, now: Date): string | null {
  const skewMs = OCCURRED_AT_SKEW_MINUTES * 60_000;
  if (occurredAt.getTime() > now.getTime() + skewMs) {
    return 'A diary entry cannot be about something that has not happened yet.';
  }
  const pastMs = OCCURRED_AT_MAX_PAST_DAYS * 24 * 60 * 60_000;
  if (occurredAt.getTime() < now.getTime() - pastMs) {
    return `A diary entry cannot be dated more than ${OCCURRED_AT_MAX_PAST_DAYS} days ago.`;
  }
  return null;
}

/**
 * Creating an entry.
 *
 * The id comes from the device, as a UUID v7, so a replayed request from a
 * drained outbox updates the same row instead of writing the day twice
 * (doc 04 §1).
 */
export const createDiaryEntryRequestSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    body: diaryBodySchema,
    occurredAt: isoDateTimeSchema,
    visibleToParticipant: z.boolean().default(true),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();

export type CreateDiaryEntryRequest = z.infer<typeof createDiaryEntryRequestSchema>;

/**
 * Editing one. Every field is optional and an absent field is left alone, so a
 * visibility toggle does not have to resend the body and risk clobbering an
 * edit someone else made in between.
 */
export const updateDiaryEntryRequestSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    body: diaryBodySchema.optional(),
    occurredAt: isoDateTimeSchema.optional(),
    visibleToParticipant: z.boolean().optional(),
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.categoryId !== undefined ||
      value.body !== undefined ||
      value.occurredAt !== undefined ||
      value.visibleToParticipant !== undefined,
    'Nothing to change.',
  );

export type UpdateDiaryEntryRequest = z.infer<typeof updateDiaryEntryRequestSchema>;

export const attachmentSummarySchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  isImage: z.boolean(),
  uploadState: z.enum(['pending', 'complete', 'failed']),
  createdAt: z.string(),
});

export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;

export const diaryEntrySchema = z.object({
  id: z.string(),
  participantId: z.string(),
  categoryId: z.string(),
  categoryLabel: z.string(),
  categoryColour: diaryCategoryColourSchema,
  body: z.string(),
  occurredAt: z.string(),
  recordedBy: z.string().nullable(),
  recordedByName: z.string().nullable(),
  recordedAt: z.string(),
  visibleToParticipant: z.boolean(),
  editedAt: z.string().nullable(),
  editCount: z.number(),
  deletedAt: z.string().nullable(),
  attachments: z.array(attachmentSummarySchema),
});

export type DiaryEntry = z.infer<typeof diaryEntrySchema>;

export const diaryRevisionSchema = z.object({
  id: z.string(),
  field: z.enum(['body', 'category', 'occurred_at', 'visibility']),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  changedBy: z.string().nullable(),
  changedByName: z.string().nullable(),
  changedAt: z.string(),
  reason: z.string().nullable(),
});

export type DiaryRevision = z.infer<typeof diaryRevisionSchema>;

/**
 * Listing and searching.
 *
 * Search is per participant over decrypted bodies (A9). Encrypted text cannot
 * use Postgres full text, and the realistic question is "what happened with
 * this person last week" rather than "search everything", so the scope of a
 * search is the scope of a participant.
 */
export const diaryQuerySchema = z
  .object({
    from: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    categoryId: z.string().uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type DiaryQuery = z.infer<typeof diaryQuerySchema>;

/**
 * Whether an entry is readable by this caller.
 *
 * Only the participant's own account is filtered: staff see everything in their
 * scope, including entries hidden from the participant, because hiding an entry
 * from the person it is about does not hide it from the team supporting them.
 * Deleted entries are readable only by an admin, so a soft delete looks like a
 * delete to everyone else while the row survives for retention.
 */
export function canReadDiaryEntry(
  entry: { visibleToParticipant: boolean; deletedAt: string | Date | null },
  viewer: { isParticipantSelf: boolean; isAdmin: boolean },
): boolean {
  if (entry.deletedAt !== null && !viewer.isAdmin) return false;
  if (viewer.isParticipantSelf && !entry.visibleToParticipant) return false;
  return true;
}

/** The plain-language label on the visibility toggle (doc 06 §4.5). */
export function describeVisibility(visible: boolean, participantName: string): string {
  return visible ? `${participantName} can see this entry` : `Hidden from ${participantName}`;
}

/** A one-line preview for the timeline, cut on a word boundary. */
export function diarySnippet(body: string, maxLength = 90): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Case-insensitive substring match, used after decryption.
 *
 * Deliberately not a word-boundary or stemming match. Workers search for
 * fragments like "seiz" or a piece of equipment, and a clever matcher that
 * misses those would be worse than a plain one that does not.
 */
export function matchesDiarySearch(body: string, search: string): boolean {
  return body.toLowerCase().includes(search.trim().toLowerCase());
}
