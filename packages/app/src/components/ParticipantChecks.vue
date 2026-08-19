<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  addDays,
  canManageSchedules,
  localDateOf,
  needsMissReason,
  type CheckSchedule,
  type CheckWindow,
  type MissedReasonCode,
} from '@vigilo/shared';
import WindowRow from '@/components/WindowRow.vue';
import BulkMissReason from '@/components/BulkMissReason.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { formatDayHeading } from '@/lib/format';

/**
 * The checks section of the participant screen (doc 06 §4.2).
 *
 * Windows for a chosen day, with anything owing a reason pinned above them.
 * Explicit dates rather than infinite scroll, so a person can say exactly what
 * period they looked at (doc 06 §7).
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();

const windows = ref<CheckWindow[]>([]);
const schedules = ref<CheckSchedule[]>([]);
const reasonCodes = ref<MissedReasonCode[]>([]);
const outstanding = ref<CheckWindow[]>([]);
const bulkOpen = ref(false);
const bulkLoading = ref(false);
const bulkNote = ref('');
const timeZone = ref(session.timeZone);
const date = ref(localDateOf(new Date(), session.timeZone));
const loading = ref(true);
const error = ref('');

const canSchedule = computed(() => canManageSchedules(session.principal?.role ?? 'worker'));

const unresolved = computed(() =>
  windows.value.filter((window) => needsMissReason(window.status, window.missReason !== null)),
);

const rest = computed(() =>
  windows.value
    .filter((window) => !needsMissReason(window.status, window.missReason !== null))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [result, list] = await Promise.all([
      api.listWindows(props.participantId, { from: date.value, to: date.value }),
      api.listSchedules(props.participantId),
    ]);
    windows.value = result.windows;
    timeZone.value = result.timeZone;
    schedules.value = list;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the checks.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** How far back an "answer them all" gathers. A month of a form left on. */
const BULK_LOOKBACK_DAYS = 30;

/**
 * Everything this participant still owes a reason for, not just today's (#19).
 *
 * A check form switched on by mistake is usually noticed days later, and by
 * then the misses are spread over every day since. Answering them from the day
 * navigator means finding each day first, so the bulk panel goes and gets them.
 */
async function openBulk(): Promise<void> {
  bulkLoading.value = true;
  error.value = '';
  try {
    const [result, codes] = await Promise.all([
      api.listWindows(props.participantId, {
        from: addDays(date.value, -BULK_LOOKBACK_DAYS),
        to: date.value,
      }),
      api.listReasonCodes(),
    ]);
    outstanding.value = result.windows
      .filter((window) => needsMissReason(window.status, window.missReason !== null))
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    reasonCodes.value = codes;

    if (outstanding.value.length === 0) {
      // The button is always live, so pressing it has to answer rather than
      // open an empty panel (D78).
      bulkNote.value = `Nothing in the last ${BULK_LOOKBACK_DAYS} days is waiting for a reason.`;
      return;
    }

    bulkNote.value = '';
    bulkOpen.value = true;
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not load the missed checks.';
  } finally {
    bulkLoading.value = false;
  }
}

async function afterBulk(): Promise<void> {
  bulkOpen.value = false;
  await load();
}

function shiftDay(by: number): void {
  date.value = addDays(date.value, by);
  void load();
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="text-lg font-semibold">Checks</h2>
      <div v-if="canSchedule" class="ml-auto flex flex-wrap gap-2 text-sm">
        <RouterLink
          class="btn border-border-default min-h-11 border px-3"
          :to="{ name: 'participant-schedule', params: { id: participantId } }"
        >
          Schedule
        </RouterLink>
        <RouterLink
          class="btn border-border-default min-h-11 border px-3"
          :to="{ name: 'participant-coverage', params: { id: participantId } }"
        >
          Coverage
        </RouterLink>
        <RouterLink
          class="btn border-border-default min-h-11 border px-3"
          :to="{ name: 'participant-forms', params: { id: participantId } }"
        >
          Forms
        </RouterLink>
      </div>
    </div>

    <FormError :message="error" />

    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn border-border-default border" @click="shiftDay(-1)">
        ← Previous day
      </button>
      <input v-model="date" class="field max-w-48" type="date" aria-label="Day" @change="load" />
      <button type="button" class="btn border-border-default border" @click="shiftDay(1)">
        Next day →
      </button>
      <span class="text-text-secondary text-sm">
        {{ formatDayHeading(`${date}T12:00:00Z`, timeZone) }}
      </span>

      <!--
        Not inside the day's own list of misses (#19). A check form left
        switched on by mistake is noticed days later, and by then the misses
        are spread over every day since, most of which this screen is not
        showing. So the button gathers them itself.
      -->
      <button
        v-if="!bulkOpen"
        type="button"
        class="btn border-border-default ml-auto border text-sm"
        :disabled="bulkLoading"
        @click="openBulk"
      >
        {{ bulkLoading ? 'Loading…' : 'Answer missed checks' }}
      </button>
    </div>

    <p v-if="bulkNote" class="text-text-secondary text-sm">{{ bulkNote }}</p>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else-if="schedules.length === 0" class="card p-4">
      <p class="font-medium">No check schedule yet.</p>
      <p class="text-text-secondary mt-1">
        {{
          canSchedule
            ? 'Set one up to start generating check windows.'
            : 'An admin or a team leader sets this up.'
        }}
      </p>
    </div>

    <p v-else-if="windows.length === 0" class="text-text-secondary">No windows on this day.</p>

    <template v-else>
      <BulkMissReason
        v-if="bulkOpen"
        :windows="outstanding"
        :reason-codes="reasonCodes"
        :time-zone="timeZone"
        @done="afterBulk"
        @cancel="bulkOpen = false"
      />

      <div v-if="unresolved.length > 0" class="space-y-2">
        <p class="text-state-missed font-semibold">
          {{ unresolved.length }} missed
          {{ unresolved.length === 1 ? 'check needs' : 'checks need' }} a reason
        </p>
        <WindowRow
          v-for="window in unresolved"
          :key="window.id"
          :window="window"
          :time-zone="timeZone"
        />
      </div>

      <div class="space-y-2">
        <WindowRow v-for="window in rest" :key="window.id" :window="window" :time-zone="timeZone" />
      </div>
    </template>
  </section>
</template>
