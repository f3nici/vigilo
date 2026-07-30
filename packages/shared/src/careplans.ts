import { z } from 'zod';

/**
 * Care plans (doc 01 §7.1, doc 03 §9, doc 06 §4.7).
 *
 * A per-participant document of standing instructions, authored by nurses and
 * admins, versioned, with draft and published states. Workers read the
 * published version and the app marks it unread until they open it.
 *
 * ## Why the body is not HTML
 *
 * Doc 07 §7 lists "care plan rich text sanitised with DOMPurify on write and on
 * render" as the XSS mitigation. This stores the author's source text instead
 * and renders it here, which is the same mitigation taken one step earlier: if
 * no HTML is ever stored, there is no stored HTML to sanitise, and a sanitiser
 * that is skipped on one code path cannot let anything through (D63).
 *
 * The renderer escapes every character of the source before it emits a single
 * tag, and the only tags it can emit are the six in `ALLOWED_TAGS`. There is no
 * passthrough: a care plan containing `<script>` renders as the visible text
 * `<script>`, which is what a nurse who typed it meant anyway.
 *
 * Both sides call `renderCarePlan`, so what the author previews is what the
 * worker reads, on a phone with no signal, from the same function.
 */

/* ------------------------------------------------------------- rich text */

/** Everything the renderer can emit. Nothing adds to this list at runtime. */
export const ALLOWED_TAGS = ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em'] as const;

export const CARE_PLAN_MAX_BODY = 50_000;

/**
 * The whole grammar, and deliberately a small one (doc 01 §7.1 asks for
 * headings and lists):
 *
 * ```
 * ## A heading            ### A smaller heading
 * - a bullet              1. a numbered step
 * **bold**                *italic*
 * ```
 *
 * A blank line starts a new block. Anything else is a paragraph. There are no
 * links and no images: a care plan is instructions for the person standing in
 * the room, and a link is something they cannot follow with no signal.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Bold and italic, applied to text that is already escaped.
 *
 * Order matters: `**` before `*`, or the bold markers are eaten as two italics.
 * The escaped text contains no `<`, so the tags introduced here are the only
 * tags in the output.
 */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

/** A stable id for a heading, built from characters we choose, never copied. */
export function headingSlug(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base === '' ? `section-${index + 1}` : `${base}-${index + 1}`;
}

export type CarePlanHeading = { level: 2 | 3; text: string; slug: string };

const HEADING = /^(#{2,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/** The headings, in order, for the table of contents doc 06 §4.7 asks for. */
export function carePlanHeadings(source: string): CarePlanHeading[] {
  const headings: CarePlanHeading[] = [];

  for (const line of source.split(/\r?\n/)) {
    const match = HEADING.exec(line.trim());
    if (!match) continue;
    const text = match[2]!.trim();
    if (text === '') continue;
    headings.push({
      level: match[1]!.length === 2 ? 2 : 3,
      text,
      slug: headingSlug(text, headings.length),
    });
  }

  return headings;
}

/**
 * The source, as HTML.
 *
 * Deterministic and pure, so the server, the author's preview and a phone with
 * no signal all produce the same document from the same bytes.
 */
export function renderCarePlan(source: string): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];

  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let paragraph: string[] = [];
  let headingIndex = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list === null) return;
    const items = list.items.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('');
    out.push(`<${list.tag}>${items}</${list.tag}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const text = heading[2]!.trim();
      if (text === '') continue;
      const tag = heading[1]!.length === 2 ? 'h2' : 'h3';
      const slug = headingSlug(text, headingIndex);
      headingIndex += 1;
      out.push(`<${tag} id="${slug}">${inline(escapeHtml(text))}</${tag}>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (list?.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(bullet[1]!);
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flushParagraph();
      if (list?.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(numbered[1]!);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return out.join('');
}

/** The body as plain text, for a PDF and for anything that cannot take HTML. */
export function carePlanPlainText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const heading = HEADING.exec(trimmed);
      if (heading) return heading[2]!.trim();
      const bullet = BULLET.exec(trimmed);
      if (bullet) return `• ${bullet[1]!}`;
      return trimmed;
    })
    .join('\n')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '');
}

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
