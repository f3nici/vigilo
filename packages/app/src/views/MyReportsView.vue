<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addDays, SELF_ACCESS_MAX_DAYS } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';

/**
 * My reports (doc 06 §6, doc 07 §5).
 *
 * A PDF of their own record for a chosen period. Doc 07 §5 names this as how
 * the right of access is served, which is why it is a file somebody can keep
 * or hand to a family member or an advocate, not a screen they have to stay
 * signed in to read.
 *
 * The link is a plain anchor with `download` rather than a fetch into a blob.
 * The browser then handles it the way it handles every other download, which
 * on a phone means it lands in Files where the person can find it again.
 */
const from = ref('');
const to = ref('');
const today = ref('');
const error = ref('');

const tooLong = computed(() => {
  if (from.value === '' || to.value === '') return false;
  const days = (Date.parse(to.value) - Date.parse(from.value)) / 86_400_000 + 1;
  return days > SELF_ACCESS_MAX_DAYS;
});

const backwards = computed(() => from.value !== '' && to.value !== '' && from.value > to.value);
const ready = computed(
  () => from.value !== '' && to.value !== '' && !tooLong.value && !backwards.value,
);

const href = computed(() => api.myRecordsPdfUrl(from.value, to.value));

function lastDays(count: number): void {
  to.value = today.value;
  from.value = addDays(today.value, -(count - 1));
}

onMounted(async () => {
  try {
    const day = await api.getMyDay();
    today.value = day.today;
  } catch {
    // Offline, or the session went. The dates still work; the download will
    // say so if it cannot reach the server.
    today.value = new Date().toISOString().slice(0, 10);
  }
  lastDays(7);
});
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold">My reports</h1>
      <p class="text-text-secondary text-lg">
        Make a copy of your record to keep, print, or give to someone helping you.
      </p>
    </header>

    <div class="card space-y-4 p-5">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn card" @click="lastDays(1)">Today</button>
        <button type="button" class="btn card" @click="lastDays(7)">Last 7 days</button>
        <button type="button" class="btn card" @click="lastDays(31)">Last month</button>
      </div>

      <div class="flex flex-wrap gap-4">
        <div class="flex-1">
          <label class="field-label" for="pdf-from">From</label>
          <input id="pdf-from" v-model="from" type="date" class="field" />
        </div>
        <div class="flex-1">
          <label class="field-label" for="pdf-to">To</label>
          <input id="pdf-to" v-model="to" type="date" class="field" :max="today" />
        </div>
      </div>

      <p v-if="backwards" class="text-state-missed text-lg">
        The first date has to be on or before the last one.
      </p>
      <p v-else-if="tooLong" class="text-state-missed text-lg">
        That is more than {{ SELF_ACCESS_MAX_DAYS }} days. Choose a shorter period.
      </p>

      <a v-if="ready" :href="href" download class="btn btn-primary w-full" @click="error = ''">
        Download my record
      </a>
      <button v-else type="button" class="btn card w-full opacity-50" disabled>
        Download my record
      </button>
    </div>

    <FormError :message="error" />

    <p class="text-text-secondary">
      The file has the same things you can read on My day and My records: what was written down and
      who wrote it.
    </p>
  </div>
</template>
