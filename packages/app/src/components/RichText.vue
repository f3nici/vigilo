<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { ALLOWED_TAGS, renderRichText } from '@vigilo/shared';

/**
 * Source text, rendered.
 *
 * The one place in the app that calls `v-html`. Care plans and the guidance
 * blocks on a check form both come through here, so there is a single answer to
 * "what can a body of text turn into on screen".
 *
 * Two layers, and the order matters. What is stored is the author's source
 * text, never HTML, and `renderRichText` escapes every character of it before
 * emitting a single tag (D63). DOMPurify then runs over our own output with the
 * same allow-list, which is doc 07 §7's "sanitised on render" kept honestly:
 * the primary control is that there is no HTML to sanitise, and this is what
 * catches a future bug in the renderer.
 */
const props = defineProps<{ source: string }>();

const html = computed(() =>
  DOMPurify.sanitize(renderRichText(props.source), {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    // The only attribute the renderer emits, on a slug it built itself from
    // characters it chose.
    ALLOWED_ATTR: ['id'],
  }),
);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="rich-text" v-html="html" />
</template>

<style scoped>
/*
 * Read on a phone in poor light, so the body is generous and the headings are
 * clearly separated. Nothing here is coloured by content.
 */
.rich-text :deep(h2) {
  font-size: 1.15rem;
  font-weight: 600;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  scroll-margin-top: 5rem;
}

.rich-text :deep(h3) {
  font-size: 1rem;
  font-weight: 600;
  margin-top: 1rem;
  margin-bottom: 0.375rem;
  scroll-margin-top: 5rem;
}

.rich-text :deep(:first-child) {
  margin-top: 0;
}

.rich-text :deep(p) {
  margin-bottom: 0.75rem;
  line-height: 1.6;
}

.rich-text :deep(ul),
.rich-text :deep(ol) {
  margin-bottom: 0.75rem;
  padding-left: 1.5rem;
  line-height: 1.6;
}

.rich-text :deep(ul) {
  list-style: disc;
}

.rich-text :deep(ol) {
  list-style: decimal;
}

.rich-text :deep(li) {
  margin-bottom: 0.25rem;
}

.rich-text :deep(strong) {
  font-weight: 600;
}

.rich-text :deep(em) {
  font-style: italic;
}

/*
 * A table is the reason tables exist here: a chart of secretion types next to
 * what to do about each. On a narrow phone it scrolls sideways inside its own
 * box rather than squeezing the words into one letter per line.
 */
.rich-text :deep(table) {
  display: block;
  overflow-x: auto;
  width: 100%;
  margin-bottom: 0.75rem;
  border-collapse: collapse;
  font-size: 0.95rem;
}

.rich-text :deep(th),
.rich-text :deep(td) {
  border: 1px solid var(--color-border-default);
  padding: 0.375rem 0.625rem;
  text-align: left;
  vertical-align: top;
  line-height: 1.5;
}

.rich-text :deep(th) {
  font-weight: 600;
  background-color: var(--color-background);
}
</style>
