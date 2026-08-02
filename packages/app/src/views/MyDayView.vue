<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addDays, recordCount, type MyDay } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import MyRecordDay from '@/components/MyRecordDay.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';

/**
 * My day (doc 06 §6).
 *
 * The screen a self-access account lands on. One day, read-only, in plain
 * language: what was written down about them and who wrote it.
 *
 * Yesterday and tomorrow are one tap away because "what happened yesterday" is
 * the second question anybody asks, and making them go to My records for it
 * would be a date picker in the way of an obvious answer.
 */
const session = useSessionStore();

const timeZone = computed(() => session.org?.timezone ?? 'Australia/Melbourne');

const day = ref<MyDay | null>(null);
const today = ref('');
const date = ref('');
const error = ref('');
const busy = ref(true);

const isToday = computed(() => date.value === today.value);
const canGoForward = computed(() => date.value < today.value);

const summary = computed(() => {
  if (day.value === null) return '';
  const count = recordCount(day.value);
  if (count === 0) return '';
  return `${count} ${count === 1 ? 'thing was' : 'things were'} written down.`;
});

async function load(next?: string): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.getMyDay(next);
    day.value = result.day;
    today.value = result.today;
    date.value = result.day.date;
  } catch (cause) {
    /*
     * A self-access account holds nothing on the device, so there is no
     * fallback to show and no point pretending otherwise. Doc 06 §7 still
     * applies: being offline is a fact, not an error, so it is said plainly.
     */
    error.value =
      cause instanceof ApiRequestError
        ? cause.message
        : 'You need a connection to read your record. Try again when you are back online.';
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">My day</h1>
      <p v-if="summary" class="text-text-secondary text-lg">{{ summary }}</p>
    </header>

    <FormError :message="error" />

    <!--
      The three controls are full-height buttons rather than a date input.
      Doc 06 §7 wants 44px targets at 200 percent text size, and a native date
      picker on a phone is neither large nor plain.
    -->
    <nav class="flex items-center gap-2" aria-label="Choose a day">
      <button type="button" class="btn card flex-1" @click="load(addDays(date, -1))">
        ← Day before
      </button>
      <button
        type="button"
        class="btn card flex-1"
        :disabled="isToday"
        :class="isToday ? 'opacity-50' : ''"
        @click="load(today)"
      >
        Today
      </button>
      <button
        type="button"
        class="btn card flex-1"
        :disabled="!canGoForward"
        :class="canGoForward ? '' : 'opacity-50'"
        @click="load(addDays(date, 1))"
      >
        Day after →
      </button>
    </nav>

    <p v-if="busy" class="text-text-secondary text-lg">Loading your day…</p>

    <MyRecordDay
      v-else-if="day"
      :day="day"
      :today="today"
      :time-zone="timeZone"
      :show-date="true"
    />
  </div>
</template>
