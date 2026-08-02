<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  canRecordChecks,
  canRecordDiary,
  describeOutstanding,
  emptyOutstanding,
  summariseOutstanding,
  type CheckWindow,
} from '@vigilo/shared';
import WindowRow from '@/components/WindowRow.vue';
import { readToday } from '@/lib/records';
import { useSessionStore } from '@/stores/session';

/**
 * What to do now, above the record (D90).
 *
 * The worker home is the participant list, so this is where a shift actually
 * starts: open a person, see what is open or owing, and act. Everything below
 * it is the record; this is the work.
 *
 * Deliberately short. Three actions and the windows that are open right now.
 * A list of everything scheduled today belongs on the Checks tab, where there
 * is room to read it.
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();

const windows = ref<CheckWindow[]>([]);
const timeZone = ref(session.timeZone);
const loaded = ref(false);

const role = computed(() => session.principal?.role ?? 'worker');

const outstanding = computed(
  () => summariseOutstanding(windows.value).get(props.participantId) ?? emptyOutstanding(),
);

const summary = computed(() => describeOutstanding(outstanding.value));

/**
 * Anything owing a reason first, then whatever is open right now. The same
 * ordering Today uses, for the same reason: a window that closed unrecorded
 * stays at the top until somebody answers for it (doc 06 §3).
 */
const nowList = computed(() => {
  const now = new Date();
  return windows.value
    .filter((window) => window.participantId === props.participantId)
    .filter((window) => {
      if (window.status === 'missed') return window.missReason === null;
      return (
        (window.status === 'pending' || window.status === 'partial') &&
        new Date(window.startsAt) <= now &&
        new Date(window.endsAt) > now
      );
    })
    .sort((a, b) => {
      const owing = (one: CheckWindow) => (one.status === 'missed' ? 0 : 1);
      return owing(a) - owing(b) || Date.parse(a.endsAt) - Date.parse(b.endsAt);
    });
});

onMounted(async () => {
  try {
    const today = await readToday();
    windows.value = today.windows;
    timeZone.value = today.timeZone;
  } catch {
    // No signal and nothing local yet. The actions still work.
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <section class="space-y-3">
    <div v-if="nowList.length > 0" class="space-y-2">
      <h2 class="text-lg font-semibold">Now</h2>
      <WindowRow
        v-for="window in nowList"
        :key="window.id"
        :window="window"
        :time-zone="timeZone"
      />
    </div>

    <p v-else-if="loaded && summary" class="text-text-secondary">{{ summary }}</p>

    <p v-else-if="loaded" class="text-text-secondary">Nothing is due right now.</p>

    <div class="flex flex-wrap gap-2">
      <RouterLink
        v-if="canRecordChecks(role)"
        class="btn btn-primary"
        :to="{ name: 'record-check', params: { id: participantId } }"
      >
        Record a check
      </RouterLink>
      <RouterLink
        v-if="canRecordDiary(role)"
        class="btn border-border-default border"
        :to="{ name: 'participant', params: { id: participantId }, query: { tab: 'diary' } }"
      >
        Write in the diary
      </RouterLink>
      <RouterLink
        class="btn border-border-default border"
        :to="{ name: 'participant', params: { id: participantId }, query: { tab: 'medication' } }"
      >
        Medication
      </RouterLink>
    </div>
  </section>
</template>
