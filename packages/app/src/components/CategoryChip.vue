<script setup lang="ts">
import { computed } from 'vue';
import type { DiaryCategoryColour } from '@vigilo/shared';

/**
 * A category chip (doc 06 §4.5).
 *
 * Colour identifies the category and says nothing about severity. There is no
 * "bad" category, and nothing here may be read as one.
 */
const props = defineProps<{
  label: string;
  colour: DiaryCategoryColour;
  selected?: boolean;
}>();

const tint = computed(() => `var(--vigilo-cat-${props.colour})`);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm"
    :style="{
      borderColor: tint,
      color: tint,
      backgroundColor: props.selected ? tint : 'transparent',
      ...(props.selected ? { color: 'var(--vigilo-surface)' } : {}),
    }"
  >
    <span
      v-if="!props.selected"
      class="inline-block h-2 w-2 rounded-full"
      :style="{ backgroundColor: tint }"
      aria-hidden="true"
    />
    {{ props.label }}
  </span>
</template>
