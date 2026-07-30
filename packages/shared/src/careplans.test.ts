import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TAGS,
  carePlanHeadings,
  carePlanPlainText,
  createCarePlanRequestSchema,
  publishCarePlanVersionRequestSchema,
  renderCarePlan,
} from './careplans.js';

describe('rendering a care plan', () => {
  it('renders headings with a stable id', () => {
    expect(renderCarePlan('## Seizure plan')).toBe('<h2 id="seizure-plan-1">Seizure plan</h2>');
    expect(renderCarePlan('### Rescue medication')).toBe(
      '<h3 id="rescue-medication-1">Rescue medication</h3>',
    );
  });

  it('renders bullets and numbered steps as lists', () => {
    expect(renderCarePlan('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderCarePlan('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('starts a new list when the kind changes', () => {
    expect(renderCarePlan('- bullet\n1. step')).toBe(
      '<ul><li>bullet</li></ul><ol><li>step</li></ol>',
    );
  });

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    expect(renderCarePlan('one line\nsame paragraph\n\nnew one')).toBe(
      '<p>one line same paragraph</p><p>new one</p>',
    );
  });

  it('renders bold and italic', () => {
    expect(renderCarePlan('**always** call *first*')).toBe(
      '<p><strong>always</strong> call <em>first</em></p>',
    );
  });

  it('does not eat bold markers as two italics', () => {
    expect(renderCarePlan('**both**')).toBe('<p><strong>both</strong></p>');
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

    /**
     * The invariant, stated once and applied to everything below.
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

    for (const attack of attacks) {
      it(`renders ${attack.slice(0, 28)} as visible text`, () => {
        const html = renderCarePlan(attack);
        expect(everyTagIsOurs(html)).toBe(true);
        // The text survives, escaped, because a nurse who typed it meant it.
        expect(html).toContain('&lt;');
      });
    }

    it('emits nothing outside the allowed tag list', () => {
      const html = renderCarePlan(
        '## Heading\n\ntext with **bold** and *italic*\n\n- a\n\n1. b\n\n<script>x</script>',
      );
      expect(everyTagIsOurs(html)).toBe(true);
      const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((match) => match[1]!);
      expect(new Set(tags)).toEqual(new Set(['h2', 'p', 'strong', 'em', 'ul', 'li', 'ol']));
    });

    it('escapes a quote inside a heading, which is where the id lives', () => {
      const html = renderCarePlan('## He said "no"');
      expect(html).toContain('id="he-said-no-1"');
      expect(html).toContain('&quot;no&quot;');
    });

    it('escapes an ampersand once, not twice', () => {
      expect(renderCarePlan('Tom & Jerry')).toBe('<p>Tom &amp; Jerry</p>');
    });
  });

  /* ------------------------------------------------------- table of contents */

  describe('the table of contents', () => {
    const source = '## First\n\ntext\n\n### Nested\n\n## Second';

    it('lists every heading in order with its level', () => {
      expect(carePlanHeadings(source)).toEqual([
        { level: 2, text: 'First', slug: 'first-1' },
        { level: 3, text: 'Nested', slug: 'nested-2' },
        { level: 2, text: 'Second', slug: 'second-3' },
      ]);
    });

    it('uses the same slugs the rendered document does', () => {
      const html = renderCarePlan(source);
      for (const heading of carePlanHeadings(source)) {
        expect(html).toContain(`id="${heading.slug}"`);
      }
    });

    it('gives two identically named headings different ids', () => {
      // Otherwise the table of contents would send both links to the first one.
      const headings = carePlanHeadings('## Same\n\n## Same');
      expect(headings[0]?.slug).not.toBe(headings[1]?.slug);
    });

    it('falls back to a numbered slug when a heading has no letters', () => {
      expect(carePlanHeadings('## ???')[0]?.slug).toBe('section-1');
    });

    it('has no headings for a plan that is all prose', () => {
      expect(carePlanHeadings('just some text')).toEqual([]);
    });
  });

  it('renders an empty body as nothing rather than an empty paragraph', () => {
    expect(renderCarePlan('')).toBe('');
    expect(renderCarePlan('\n\n  \n')).toBe('');
  });

  it('reduces to plain text for a PDF', () => {
    expect(carePlanPlainText('## Seizure plan\n\n- **call** first\n\nthen wait')).toBe(
      'Seizure plan\n\n• call first\n\nthen wait',
    );
  });
});

describe('the plan', () => {
  it('starts with an empty body when none is given', () => {
    expect(createCarePlanRequestSchema.parse({ title: 'Daily support' }).body).toBe('');
  });

  it('requires a change summary to publish', () => {
    // Every assigned worker is about to be asked to read this again, so "what
    // changed" is the difference between skimming and finding the paragraph.
    expect(publishCarePlanVersionRequestSchema.safeParse({ changeSummary: '' }).success).toBe(
      false,
    );
    expect(publishCarePlanVersionRequestSchema.safeParse({ changeSummary: '  ' }).success).toBe(
      false,
    );
    expect(
      publishCarePlanVersionRequestSchema.safeParse({ changeSummary: 'Added the seizure plan' })
        .success,
    ).toBe(true);
  });
});
