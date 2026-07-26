<script setup lang="ts">
import StatusPill from '@/components/StatusPill.vue';
import type { RecordState } from '@/components/StatusPill.vue';

/**
 * Today is the worker's main screen from Phase 3 onward. In Phase 0 it shows
 * the record states the design system defines, so the palette and the
 * colour-plus-icon-plus-label rule are visible and reviewable before any
 * clinical UI is built on them.
 */
const states: RecordState[] = [
  'complete',
  'partial',
  'pending',
  'missed',
  'not-expected',
  'late',
  'syncing',
];
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Today</h1>
      <p class="text-text-secondary mt-1">
        Check windows appear here once schedules exist. Nothing is scheduled yet.
      </p>
    </div>

    <section class="card p-4">
      <h2 class="text-lg font-semibold">Record states</h2>
      <p class="text-text-secondary mt-1 text-sm">
        Colour signals record state only, never a clinical value, and never on its own. Every state
        carries an icon and a label too.
      </p>
      <ul class="mt-4 flex flex-wrap gap-2">
        <li v-for="state in states" :key="state">
          <StatusPill :state="state" />
        </li>
      </ul>
    </section>
  </div>
</template>
