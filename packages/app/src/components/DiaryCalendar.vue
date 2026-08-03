<script setup lang="ts">
import { computed } from 'vue';
import {
  addMonths,
  isSameMonth,
  monthGrid,
  startOfMonth,
  utcToZoned,
  type DiaryEntry,
} from '@vigilo/shared';

/**
 * The month grid on the diary tab.
 *
 * The diary is the day book. Somebody looks at it to answer "what has Alice
 * got on this week", which is a question a reverse-chronological list of
 * everything that has already happened cannot answer at all.
 *
 * The grid draws markers, not entry text: a cell wide enough for a phone is
 * not wide enough for "GP appointment, Dr Patel, bring the referral", and a
 * truncated version of that is worse than a dot. Picking a day is what shows
 * the detail.
 */
const props = defineProps<{
  /** Any date in the month on show. */
  month: string;
  selected: string;
  /** Today in the org timezone, so "today" is the org's day, not the device's. */
  today: string;
  entries: DiaryEntry[];
  timeZone: string;
}>();

const emit = defineEmits<{ 'update:month': [string]; 'update:selected': [string] }>();

const weeks = computed(() => monthGrid(props.month));

const monthLabel = computed(() => {
  const [year, month] = props.month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(
    new Date(year!, month! - 1, 1),
  );
});

/** Monday first, matching the grid. */
const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * How many entries sit on each day, keyed by the day in the org timezone.
 *
 * The date has to be resolved through the org zone rather than read off the
 * ISO string: an 08:00 appointment in Perth is 00:00 UTC, and keying on the
 * raw string would file it under the day before for everybody.
 */
const countByDay = computed(() => {
  const counts = new Map<string, number>();
  for (const entry of props.entries) {
    if (entry.deletedAt) continue;
    const day = utcToZoned(new Date(entry.occurredAt), props.timeZone).date;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
});

function dayNumber(isoDate: string): string {
  return String(Number(isoDate.slice(8, 10)));
}

function describe(isoDate: string): string {
  const count = countByDay.value.get(isoDate) ?? 0;
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(year!, month! - 1, day!));
  if (count === 0) return `${date}, nothing on`;
  return `${date}, ${count} ${count === 1 ? 'entry' : 'entries'}`;
}
</script>

<template>
  <div class="card p-3">
    <div class="mb-2 flex items-center gap-2">
      <button
        type="button"
        class="hover:bg-primary-subtle min-h-11 rounded-lg px-3"
        :aria-label="`Previous month, ${monthLabel}`"
        @click="emit('update:month', addMonths(startOfMonth(props.month), -1))"
      >
        ←
      </button>
      <h3 class="flex-1 text-center text-lg font-semibold" aria-live="polite">{{ monthLabel }}</h3>
      <button
        type="button"
        class="hover:bg-primary-subtle min-h-11 rounded-lg px-3"
        :aria-label="`Next month, ${monthLabel}`"
        @click="emit('update:month', addMonths(startOfMonth(props.month), 1))"
      >
        →
      </button>
    </div>

    <div class="text-text-secondary grid grid-cols-7 gap-1 text-center text-xs font-semibold">
      <span v-for="name in weekdayNames" :key="name" class="py-1">{{ name }}</span>
    </div>

    <div class="grid grid-cols-7 gap-1">
      <template v-for="week in weeks" :key="week[0]">
        <button
          v-for="day in week"
          :key="day"
          type="button"
          class="flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1"
          :class="[
            day === props.selected
              ? 'bg-primary-subtle text-primary font-semibold'
              : 'hover:bg-primary-subtle',
            isSameMonth(day, props.month) ? '' : 'opacity-40',
          ]"
          :style="
            day === props.today && day !== props.selected
              ? { outline: '1px solid var(--vigilo-primary)' }
              : {}
          "
          :aria-pressed="day === props.selected"
          :aria-label="describe(day)"
          @click="emit('update:selected', day)"
        >
          <span class="tabular text-sm" aria-hidden="true">{{ dayNumber(day) }}</span>
          <!--
            One dot means something is on, not how much. Counting dots is a
            worse way of reading a number than reading the number, and the
            count is in the label for anyone listening to it.
          -->
          <span
            v-if="countByDay.get(day)"
            class="h-1.5 w-1.5 rounded-full"
            :style="{ backgroundColor: 'var(--vigilo-primary)' }"
            aria-hidden="true"
          ></span>
          <span v-else class="h-1.5 w-1.5" aria-hidden="true"></span>
        </button>
      </template>
    </div>
  </div>
</template>
