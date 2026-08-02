<script setup lang="ts">
import { computed } from 'vue';
import { carePlanHeadings } from '@vigilo/shared';
import RichText from '@/components/RichText.vue';

/**
 * A care plan, rendered (doc 06 §4.7).
 *
 * The body goes through `RichText`, which is the only thing in the app that
 * turns source text into markup. What is left here is what is particular to a
 * care plan: the table of contents, and saying so when nothing has been written.
 */
/*
 * `hideContents` rather than `showContents`, because Vue casts an absent
 * boolean prop to false rather than undefined. A `showContents` that defaults
 * to false would hide the table of contents everywhere it was not spelled out,
 * which is exactly what it did until the browser showed it.
 */
const props = defineProps<{ body: string; hideContents?: boolean }>();

const headings = computed(() => carePlanHeadings(props.body));

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

      <RichText :source="body" />
    </template>
  </div>
</template>
