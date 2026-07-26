<script lang="ts">
/**
 * Record state, never clinical state (doc 08 §3).
 *
 * Colour is never the only signal: every state carries an icon and a text
 * label, both for accessibility and because "missed" is too important to
 * encode in a hue.
 */
export type RecordState =
  'complete' | 'partial' | 'pending' | 'missed' | 'not-expected' | 'late' | 'syncing';
</script>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ state: RecordState }>();

const meta: Record<RecordState, { label: string; colour: string; glyph: string }> = {
  complete: { label: 'Recorded', colour: 'var(--vigilo-complete)', glyph: '✓' },
  partial: { label: 'Partly recorded', colour: 'var(--vigilo-partial)', glyph: '◐' },
  pending: { label: 'Open', colour: 'var(--vigilo-pending)', glyph: '○' },
  missed: { label: 'Missed', colour: 'var(--vigilo-missed)', glyph: '✕' },
  'not-expected': { label: 'Not expected', colour: 'var(--vigilo-not-expected)', glyph: '–' },
  late: { label: 'Late', colour: 'var(--vigilo-late)', glyph: '↻' },
  syncing: { label: 'Syncing', colour: 'var(--vigilo-syncing)', glyph: '↑' },
};

const current = computed(() => meta[props.state]);
</script>

<template>
  <span
    class="border-border-default inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium"
    :style="{ color: current.colour }"
  >
    <span aria-hidden="true">{{ current.glyph }}</span>
    <span>{{ current.label }}</span>
  </span>
</template>
