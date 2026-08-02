/**
 * The rich text renderer (D63).
 *
 * Used by care plans (doc 01 §7.1) and by the info blocks an admin can put on a
 * check form. Both are prose somebody wrote for the worker standing in the
 * room, so both read the same way, from the same function, on a phone with no
 * signal.
 *
 * ## Why none of this is HTML
 *
 * Doc 07 §7 lists "care plan rich text sanitised with DOMPurify on write and on
 * render" as the XSS mitigation. This stores the author's source text instead
 * and renders it here, which is the same mitigation taken one step earlier: if
 * no HTML is ever stored, there is no stored HTML to sanitise, and a sanitiser
 * that is skipped on one code path cannot let anything through.
 *
 * The renderer escapes every character of the source before it emits a single
 * tag, and the only tags it can emit are the ones in `ALLOWED_TAGS`. There is no
 * passthrough: a body containing `<script>` renders as the visible text
 * `<script>`, which is what the nurse who typed it meant anyway.
 */

/** Everything the renderer can emit. Nothing adds to this list at runtime. */
export const ALLOWED_TAGS = [
  'h2',
  'h3',
  'p',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
] as const;

/**
 * The whole grammar, and deliberately a small one:
 *
 * ```
 * ## A heading            ### A smaller heading
 * - a bullet              1. a numbered step
 * **bold**                *italic*
 *
 * | Type | What to do |     a table, the header row first and a row of
 * | ---- | ---------- |     dashes under it
 * | 1    | Note it    |
 * ```
 *
 * A blank line starts a new block. Anything else is a paragraph. There are no
 * links and no images: this is instructions for the person standing in the
 * room, and a link is something they cannot follow with no signal.
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

export type RichTextHeading = { level: 2 | 3; text: string; slug: string };

const HEADING = /^(#{2,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/** A row of a table: starts and ends with a pipe. */
const TABLE_ROW = /^\|(.*)\|$/;

/**
 * The dashes under a header row, which is what tells a table from a paragraph
 * that happens to contain pipes. Alignment colons are accepted because people
 * type them out of habit, and ignored, because an aligned column would mean an
 * attribute on the tag and this renderer emits none.
 */
const TABLE_DIVIDER = /^\|(\s*:?-+:?\s*\|)+$/;

function tableCells(line: string): string[] {
  return TABLE_ROW.exec(line)![1]!
    .split('|')
    .map((cell) => cell.trim());
}

/** The headings, in order, for the table of contents doc 06 §4.7 asks for. */
export function richTextHeadings(source: string): RichTextHeading[] {
  const headings: RichTextHeading[] = [];

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
export function renderRichText(source: string): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];

  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let table: { columns: number; header: string[]; rows: string[][] } | null = null;
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

  /**
   * Every row is padded or truncated to the header's width. A ragged table is
   * a typo rather than an intention, and a renderer that emitted the ragged
   * version would produce a table that reads differently on a phone than it
   * does in the preview.
   */
  const flushTable = () => {
    if (table === null) return;
    const cell = (tag: 'th' | 'td', text: string) => `<${tag}>${inline(escapeHtml(text))}</${tag}>`;
    const row = (tag: 'th' | 'td', cells: string[]) =>
      `<tr>${Array.from({ length: table!.columns }, (_, index) =>
        cell(tag, cells[index] ?? ''),
      ).join('')}</tr>`;

    const head = `<thead>${row('th', table.header)}</thead>`;
    const body =
      table.rows.length === 0
        ? ''
        : `<tbody>${table.rows.map((cells) => row('td', cells)).join('')}</tbody>`;
    out.push(`<table>${head}${body}</table>`);
    table = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();

    if (line === '') {
      flushAll();
      continue;
    }

    // Rows of a table already opened. Anything else ends it.
    if (table !== null) {
      if (TABLE_ROW.test(line)) {
        table.rows.push(tableCells(line));
        continue;
      }
      flushTable();
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const text = heading[2]!.trim();
      if (text === '') continue;
      const tag = heading[1]!.length === 2 ? 'h2' : 'h3';
      const slug = headingSlug(text, headingIndex);
      headingIndex += 1;
      out.push(`<${tag} id="${slug}">${inline(escapeHtml(text))}</${tag}>`);
      continue;
    }

    /*
     * A table opens only when the next line is the row of dashes. Without that
     * check a paragraph mentioning a pipe would become a one-column table, and
     * a bullet like `- give 2 | 3 tablets` reads as text to the person who
     * typed it.
     */
    const next = lines[index + 1]?.trim() ?? '';
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(next)) {
      flushParagraph();
      flushList();
      const header = tableCells(line);
      table = { columns: header.length, header, rows: [] };
      index += 1;
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

  flushAll();

  return out.join('');
}

/** The body as plain text, for a PDF and for anything that cannot take HTML. */
export function richTextPlainText(source: string): string {
  return source
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      const heading = HEADING.exec(trimmed);
      if (heading) return [heading[2]!.trim()];
      const bullet = BULLET.exec(trimmed);
      if (bullet) return [`• ${bullet[1]!}`];
      // A row of dashes carries nothing a reader needs, and a PDF that kept it
      // would print a line of punctuation between two rows of words.
      if (TABLE_DIVIDER.test(trimmed)) return [];
      if (TABLE_ROW.test(trimmed)) return [tableCells(trimmed).join(' · ')];
      return [trimmed];
    })
    .join('\n')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '');
}
