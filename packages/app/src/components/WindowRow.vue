<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { needsMissReason, type CheckWindow } from '@vigilo/shared';
import StatusPill from '@/components/StatusPill.vue';
import type { RecordState } from '@/components/StatusPill.vue';
import { closesIn, formatWindowRange } from '@/lib/format';

/**
 * One check window in a list (doc 06 §3).
 *
 * Colour signals the record's state and never a recorded value, and it is never
 * the only signal: the pill carries an icon and a word as well.
 */
const props = defineProps<{
  window: CheckWindow;
  timeZone: string;
  /** Shown on Today, where one row can be any participant. */
  participantName?: string | undefined;
}>();

const state = computed<RecordState>(() => {
  if (props.window.status === 'complete' && props.window.isLate) return 'late';
  if (props.window.status === 'not_expected') return 'not-expected';
  return props.window.status;
});

const owesReason = computed(() =>
  needsMissReason(props.window.status, props.window.missReason !== null),
);

const progress = computed(() => {
  if (props.window.requiredFieldCount === 0) return 0;
  return Math.round((props.window.filledRequiredCount / props.window.requiredFieldCount) * 100);
});
</script>

<template>
  <RouterLink
    class="card hover:border-primary block p-3"
    :class="window.status === 'not_expected' ? 'opacity-70' : ''"
    :to="{ name: 'window', params: { id: window.id }, query: { tz: timeZone } }"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div>
        <p v-if="participantName" class="font-semibold">{{ participantName }}</p>
        <p class="tabular">
          {{ formatWindowRange(window.startsAt, window.endsAt, timeZone) }}
          <span class="text-text-secondary ml-1 text-sm">{{ window.scheduleName }}</span>
        </p>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <StatusPill :state="state" />
      </div>
    </div>

    <p v-if="owesReason" class="text-state-missed mt-1 text-sm font-medium">
      Tap to record a reason
    </p>
    <p v-else-if="window.missReason" class="text-text-secondary mt-1 text-sm">
      Reason: {{ window.missReason.label }}
    </p>
    <p v-else-if="window.status === 'not_expected'" class="text-text-secondary mt-1 text-sm">
      {{ window.coverageReason }}
    </p>
    <p v-else-if="window.status === 'partial'" class="text-text-secondary mt-1 text-sm">
      {{ window.filledRequiredCount }} of {{ window.requiredFieldCount }} required fields ·
      {{ closesIn(window.endsAt) }}
      <span
        class="bg-border-default mt-1 block h-1.5 w-full max-w-48 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <span
          class="block h-full rounded-full"
          :style="{ width: `${progress}%`, backgroundColor: 'var(--vigilo-partial)' }"
        />
      </span>
    </p>
    <p v-else-if="window.status === 'pending'" class="text-text-secondary mt-1 text-sm">
      {{ closesIn(window.endsAt) }}
    </p>
    <p v-else-if="window.status === 'complete'" class="text-text-secondary mt-1 text-sm">
      Recorded<span v-if="window.isLate">
        late, {{ window.lateByMinutes }} minutes after it closed</span
      >.
    </p>
  </RouterLink>
</template>
