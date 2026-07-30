<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { ALLOWED_TAGS, carePlanHeadings, renderCarePlan } from '@vigilo/shared';

/**
 * A care plan, rendered (doc 06 §4.7).
 *
 * Two layers, and the order matters. The stored body is the author's source
 * text, never HTML, and `renderCarePlan` escapes every character of it before
 * emitting a single tag (D63). DOMPurify then runs over our own output with the
 * same allow-list, which is doc 07 §7's "sanitised on render" kept honestly:
 * the primary control is that there is no HTML to sanitise, and this is what
 * catches a future bug in the renderer.
 */
/*
 * `hideContents` rather than `showContents`, because Vue casts an absent
 * boolean prop to false rather than undefined. A `showContents` that defaults
 * to false would hide the table of contents everywhere it was not spelled out,
 * which is exactly what it did until the browser showed it.
 */
const props = defineProps<{ body: string; hideContents?: boolean }>();

const headings = computed(() => carePlanHeadings(props.body));

const html = computed(() =>
  DOMPurify.sanitize(renderCarePlan(props.body), {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    // The only attribute the renderer emits, on a slug it built itself from
    // characters it chose.
    ALLOWED_ATTR: ['id'],
  }),
);

const empty = computed(() => props.body.trim() === '');
</script>

<template>
  <div class="space-y-4">
    <p v-if="empty" class="text-text-secondary">Nothing has been written yet.</p>

    <template v-else>
      <!--
        The table of contents doc 06 §4.7 asks for. Skipped when there is only
        one heading, which is a list of one and reads as clutter.
      -->
      <nav v-if="!hideContents && headings.length > 1" class="card p-4" aria-label="Sections">
        <p class="field-label">On this page</p>
        <ul class="space-y-1">
          <li
            v-for="heading in headings"
            :key="heading.slug"
            :class="heading.level === 3 ? 'ml-4' : ''"
          >
            <a :href="`#${heading.slug}`" class="underline">{{ heading.text }}</a>
          </li>
        </ul>
      </nav>

      <!-- eslint-disable-next-line vue/no-v-html -->
      <article class="care-plan" v-html="html" />
    </template>
  </div>
</template>

<style scoped>
/*
 * The plan is read on a phone in poor light, so the body is generous and the
 * headings are clearly separated. Nothing here is coloured by content.
 */
.care-plan :deep(h2) {
  font-size: 1.15rem;
  font-weight: 600;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  scroll-margin-top: 5rem;
}

.care-plan :deep(h3) {
  font-size: 1rem;
  font-weight: 600;
  margin-top: 1rem;
  margin-bottom: 0.375rem;
  scroll-margin-top: 5rem;
}

.care-plan :deep(p) {
  margin-bottom: 0.75rem;
  line-height: 1.6;
}

.care-plan :deep(ul),
.care-plan :deep(ol) {
  margin-bottom: 0.75rem;
  padding-left: 1.5rem;
  line-height: 1.6;
}

.care-plan :deep(ul) {
  list-style: disc;
}

.care-plan :deep(ol) {
  list-style: decimal;
}

.care-plan :deep(li) {
  margin-bottom: 0.25rem;
}

.care-plan :deep(strong) {
  font-weight: 600;
}

.care-plan :deep(em) {
  font-style: italic;
}
</style>
