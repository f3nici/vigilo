<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addDays, dayIsEmpty, SELF_ACCESS_MAX_DAYS, type MyRecords } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import MyRecordDay from '@/components/MyRecordDay.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';

/**
 * My records (doc 06 §6).
 *
 * The same day view over a range they choose. Explicit dates, never infinite
 * scroll: doc 06 §7 wants a person to be able to say which period they looked
 * at, and that applies to the person the record is about as much as to staff.
 */
const session = useSessionStore();

const timeZone = computed(() => session.timeZone);

const records = ref<MyRecords | null>(null);
const today = ref('');
const from = ref('');
const to = ref('');
const error = ref('');
const busy = ref(false);

/** Empty days are kept but folded away, so a quiet fortnight is not a wall. */
const hideEmpty = ref(true);

const shown = computed(() => {
  if (records.value === null) return [];
  const days = [...records.value.days].reverse();
  return hideEmpty.value ? days.filter((day) => !dayIsEmpty(day)) : days;
});

const emptyCount = computed(() =>
  records.value === null ? 0 : records.value.days.filter(dayIsEmpty).length,
);

const nothingAtAll = computed(
  () => !busy.value && error.value === '' && records.value !== null && shown.value.length === 0,
);

async function load(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.getMyRecords(from.value, to.value);
    records.value = result.records;
    today.value = result.today;
  } catch (cause) {
    records.value = null;
    error.value =
      cause instanceof ApiRequestError
        ? cause.message
        : 'You need a connection to read your record. Try again when you are back online.';
  } finally {
    busy.value = false;
  }
}

function lastDays(count: number): void {
  to.value = today.value;
  from.value = addDays(today.value, -(count - 1));
  void load();
}

onMounted(async () => {
  const day = await api.getMyDay().catch(() => null);
  today.value = day?.today ?? new Date().toISOString().slice(0, 10);
  lastDays(7);
});
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">My records</h1>
      <p class="text-text-secondary text-lg">
        Pick the days you want to read. You can look at up to {{ SELF_ACCESS_MAX_DAYS }} days at a
        time.
      </p>
    </header>

    <div class="card space-y-4 p-5">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn card" @click="lastDays(7)">Last 7 days</button>
        <button type="button" class="btn card" @click="lastDays(14)">Last 14 days</button>
        <button type="button" class="btn card" @click="lastDays(31)">Last month</button>
      </div>

      <div class="flex flex-wrap gap-4">
        <div class="flex-1">
          <label class="field-label" for="from">From</label>
          <input id="from" v-model="from" type="date" class="field" :max="to" />
        </div>
        <div class="flex-1">
          <label class="field-label" for="to">To</label>
          <input id="to" v-model="to" type="date" class="field" :min="from" :max="today" />
        </div>
      </div>

      <button type="button" class="btn btn-primary w-full" :disabled="busy" @click="load">
        {{ busy ? 'Loading…' : 'Show these days' }}
      </button>

      <label class="flex min-h-11 items-center gap-3 text-lg">
        <input v-model="hideEmpty" type="checkbox" class="size-5" />
        Hide days with nothing written down
      </label>
    </div>

    <FormError :message="error" />

    <p v-if="nothingAtAll" class="text-text-secondary text-lg">
      Nothing was written down in these days.
      <span v-if="hideEmpty && emptyCount > 0">
        Untick the box above to see every day in the period.
      </span>
    </p>

    <div class="space-y-8">
      <MyRecordDay
        v-for="day in shown"
        :key="day.date"
        :day="day"
        :today="today"
        :time-zone="timeZone"
        :show-date="true"
      />
    </div>
  </div>
</template>
