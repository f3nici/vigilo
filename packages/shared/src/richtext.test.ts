import { describe, expect, it } from 'vitest';
import { ALLOWED_TAGS, renderRichText, richTextHeadings, richTextPlainText } from './richtext.js';

describe('rendering rich text', () => {
  /**
   * The invariant, stated once and applied everywhere below.
   *
   * Not "the output does not contain the word onclick": it does, as visible
   * text, because the nurse typed it. What matters is that every `<` in the
   * output opens one of our own tags, and the only attribute anywhere is the
   * `id` the renderer builds from characters it chose itself.
   */
  const ALLOWED_TAG_SHAPE = new RegExp(`^</?(${ALLOWED_TAGS.join('|')})( id="[a-z0-9-]+")?>$`);

  function everyTagIsOurs(html: string): boolean {
    return (html.match(/<[^>]*>/g) ?? []).every((tag) => ALLOWED_TAG_SHAPE.test(tag));
  }

  it('renders headings with a stable id', () => {
    expect(renderRichText('## Seizure plan')).toBe('<h2 id="seizure-plan-1">Seizure plan</h2>');
    expect(renderRichText('### Rescue medication')).toBe(
      '<h3 id="rescue-medication-1">Rescue medication</h3>',
    );
  });

  it('renders bullets and numbered steps as lists', () => {
    expect(renderRichText('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderRichText('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('starts a new list when the kind changes', () => {
    expect(renderRichText('- bullet\n1. step')).toBe(
      '<ul><li>bullet</li></ul><ol><li>step</li></ol>',
    );
  });

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    expect(renderRichText('one line\nsame paragraph\n\nnew one')).toBe(
      '<p>one line same paragraph</p><p>new one</p>',
    );
  });

  it('renders bold and italic', () => {
    expect(renderRichText('**always** call *first*')).toBe(
      '<p><strong>always</strong> call <em>first</em></p>',
    );
  });

  it('does not eat bold markers as two italics', () => {
    expect(renderRichText('**both**')).toBe('<p><strong>both</strong></p>');
  });

  /* ------------------------------------------------------------- escaping */

  describe('escaping', () => {
    /**
     * The whole security argument for D63 is in this block. Nothing the author
     * types can become a tag, because every character is escaped before a
     * single tag is emitted.
     */
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">click</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<style>body{display:none}</style>',
      '"><script>alert(1)</script>',
      "<svg/onload=alert('x')>",
      '<div onclick="alert(1)">text</div>',
    ];

    for (const attack of attacks) {
      it(`renders ${attack.slice(0, 28)} as visible text`, () => {
        const html = renderRichText(attack);
        expect(everyTagIsOurs(html)).toBe(true);
        // The text survives, escaped, because a nurse who typed it meant it.
        expect(html).toContain('&lt;');
      });
    }

    it('emits nothing outside the allowed tag list', () => {
      const html = renderRichText(
        '## Heading\n\ntext with **bold** and *italic*\n\n- a\n\n1. b\n\n<script>x</script>',
      );
      expect(everyTagIsOurs(html)).toBe(true);
      const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((match) => match[1]!);
      expect(new Set(tags)).toEqual(new Set(['h2', 'p', 'strong', 'em', 'ul', 'li', 'ol']));
    });

    it('escapes a quote inside a heading, which is where the id lives', () => {
      const html = renderRichText('## He said "no"');
      expect(html).toContain('id="he-said-no-1"');
      expect(html).toContain('&quot;no&quot;');
    });

    it('escapes an ampersand once, not twice', () => {
      expect(renderRichText('Tom & Jerry')).toBe('<p>Tom &amp; Jerry</p>');
    });
  });

  /* ------------------------------------------------------- table of contents */

  describe('the table of contents', () => {
    const source = '## First\n\ntext\n\n### Nested\n\n## Second';

    it('lists every heading in order with its level', () => {
      expect(richTextHeadings(source)).toEqual([
        { level: 2, text: 'First', slug: 'first-1' },
        { level: 3, text: 'Nested', slug: 'nested-2' },
        { level: 2, text: 'Second', slug: 'second-3' },
      ]);
    });

    it('uses the same slugs the rendered document does', () => {
      const html = renderRichText(source);
      for (const heading of richTextHeadings(source)) {
        expect(html).toContain(`id="${heading.slug}"`);
      }
    });

    it('gives two identically named headings different ids', () => {
      // Otherwise the table of contents would send both links to the first one.
      const headings = richTextHeadings('## Same\n\n## Same');
      expect(headings[0]?.slug).not.toBe(headings[1]?.slug);
    });

    it('falls back to a numbered slug when a heading has no letters', () => {
      expect(richTextHeadings('## ???')[0]?.slug).toBe('section-1');
    });

    it('has no headings for a plan that is all prose', () => {
      expect(richTextHeadings('just some text')).toEqual([]);
    });
  });

  /* ----------------------------------------------------------------- tables */

  describe('tables', () => {
    /** The case they exist for: a reference chart beside the field asking about it. */
    const chart = [
      '| Type | Looks like |',
      '| ---- | ---------- |',
      '| 1 | Clear |',
      '| 2 | White |',
    ].join('\n');

    it('renders a header row and a body', () => {
      expect(renderRichText(chart)).toBe(
        '<table><thead><tr><th>Type</th><th>Looks like</th></tr></thead>' +
          '<tbody><tr><td>1</td><td>Clear</td></tr><tr><td>2</td><td>White</td></tr></tbody></table>',
      );
    });

    it('accepts alignment colons and ignores them', () => {
      // People type these out of habit. Honouring them would mean an attribute,
      // and this renderer emits none.
      const aligned = '| A | B |\n| :--- | ---: |\n| 1 | 2 |';
      expect(renderRichText(aligned)).toContain('<th>A</th><th>B</th>');
      expect(renderRichText(aligned)).not.toContain('align');
    });

    it('pads a short row and truncates a long one to the header width', () => {
      const ragged = '| A | B |\n| - | - |\n| only |\n| 1 | 2 | 3 |';
      const html = renderRichText(ragged);
      expect(html).toContain('<tr><td>only</td><td></td></tr>');
      expect(html).toContain('<tr><td>1</td><td>2</td></tr>');
      expect(html).not.toContain('<td>3</td>');
    });

    it('renders a header with no rows under it', () => {
      expect(renderRichText('| A | B |\n| - | - |')).toBe(
        '<table><thead><tr><th>A</th><th>B</th></tr></thead></table>',
      );
    });

    it('needs the row of dashes, so prose with a pipe stays prose', () => {
      // Otherwise "| 3 tablets |" in the middle of a plan becomes a table.
      expect(renderRichText('| give 2 or 3 |')).toBe('<p>| give 2 or 3 |</p>');
      expect(renderRichText('- give 2 | 3 tablets')).toBe('<ul><li>give 2 | 3 tablets</li></ul>');
    });

    it('ends the table at the first line that is not a row', () => {
      expect(renderRichText('| A |\n| - |\n| 1 |\nafter')).toBe(
        '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><p>after</p>',
      );
    });

    it('escapes inside a cell and still allows bold', () => {
      const html = renderRichText('| A |\n| - |\n| <script>x</script> **bold** |');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('<strong>bold</strong>');
      expect(everyTagIsOurs(html)).toBe(true);
    });

    it('reduces to readable plain text for a PDF', () => {
      expect(richTextPlainText(chart)).toBe('Type · Looks like\n1 · Clear\n2 · White');
    });
  });

  it('renders an empty body as nothing rather than an empty paragraph', () => {
    expect(renderRichText('')).toBe('');
    expect(renderRichText('\n\n  \n')).toBe('');
  });

  it('reduces to plain text for a PDF', () => {
    expect(richTextPlainText('## Seizure plan\n\n- **call** first\n\nthen wait')).toBe(
      'Seizure plan\n\n• call first\n\nthen wait',
    );
  });
});
