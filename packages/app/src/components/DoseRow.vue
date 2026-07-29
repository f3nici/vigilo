<script setup lang="ts">
import { computed } from 'vue';
import { describeDoseStatus, localDateOf, type MedicationDose } from '@vigilo/shared';
import StatusPill from '@/components/StatusPill.vue';
import type { RecordState } from '@/components/StatusPill.vue';
import { formatWindowTime } from '@/lib/format';

/**
 * One dose in a list.
 *
 * Colour signals the record's state and never the medication, and it is never
 * the only signal: the pill carries an icon and a word, and the status is
 * written out underneath.
 */
const props = defineProps<{
  dose: MedicationDose;
  timeZone: string;
  participantName?: string | undefined;
}>();

const emit = defineEmits<{ open: [MedicationDose] }>();

/**
 * A dose has more outcomes than a window has states, so several of them share
 * a pill. Given and self-administered both mean the medication reached the
 * person; refused, withheld and not required all mean it did not, and the word
 * underneath says which.
 */
const state = computed<RecordState>(() => {
  switch (props.dose.status) {
    case 'given':
      return props.dose.isLate ? 'late' : 'complete';
    case 'self_administered':
      return 'complete';
    case 'pending':
      return 'pending';
    case 'missed':
      return 'missed';
    default:
      return 'not-expected';
  }
});

const answerable = computed(
  () => props.dose.status === 'pending' || props.dose.status === 'missed',
);

/**
 * The time, with the day in front of it when the dose is not today's.
 *
 * A worker on a late shift sees tonight's 21:00 and tomorrow's 08:00 in the
 * same list, and two rows reading "08:00 Keppra 250 mg" with nothing to tell
 * them apart is how somebody signs off the wrong one.
 */
const when = computed(() => {
  const time = formatWindowTime(props.dose.dueAt, props.timeZone);
  const on = localDateOf(new Date(props.dose.dueAt), props.timeZone);
  if (on === localDateOf(new Date(), props.timeZone)) return time;

  const day = new Intl.DateTimeFormat('en-AU', {
    timeZone: props.timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(props.dose.dueAt));

  return `${day}, ${time}`;
});
</script>

<template>
  <component
    :is="answerable ? 'button' : 'div'"
    class="card block w-full p-3 text-left"
    :class="[
      answerable ? 'hover:border-primary' : '',
      dose.status === 'not_required' && !dose.expected ? 'opacity-70' : '',
    ]"
    :type="answerable ? 'button' : undefined"
    @click="answerable ? emit('open', dose) : undefined"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div>
        <p v-if="participantName" class="font-semibold">{{ participantName }}</p>
        <p class="tabular">
          {{ when }}
          <span class="ml-1 font-medium">{{ dose.medicationName }} {{ dose.dose }}</span>
        </p>
      </div>

      <div class="ml-auto">
        <StatusPill :state="state" />
      </div>
    </div>

    <p class="text-text-secondary mt-1 text-sm">
      {{ describeDoseStatus(dose.status) }}<span v-if="dose.isLate">, signed off late</span>
      <span v-if="dose.route">, {{ dose.route }}</span>
    </p>

    <p v-if="!dose.expected && dose.coverageReason" class="text-text-secondary mt-1 text-sm">
      {{ dose.coverageReason }}
    </p>
    <p v-else-if="answerable" class="text-state-missed mt-1 text-sm font-medium">Tap to sign off</p>
  </component>
</template>
