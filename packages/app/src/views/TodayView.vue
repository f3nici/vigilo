<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  doseSortRank,
  needsMissReason,
  participantShortName,
  windowSortRank,
  type CheckWindow,
  type MedicationDose,
  type ParticipantSummary,
} from '@vigilo/shared';
import WindowRow from '@/components/WindowRow.vue';
import DoseRow from '@/components/DoseRow.vue';
import DoseSignOff from '@/components/DoseSignOff.vue';
import FormError from '@/components/FormError.vue';
import { ApiRequestError } from '@/api/client';
import { readDueDoses, readToday } from '@/lib/records';
import { useOfflineStore } from '@/stores/offline';
import { useSessionStore } from '@/stores/session';

/**
 * Today (doc 06 §3).
 *
 * The worker's main screen, answering "what do I need to do right now". The
 * ordering is the whole design: anything owing a reason sits at the top and
 * stays there until it is answered, then what is open now, then the rest.
 *
 * Not-expected windows are shown greyed rather than hidden, so the record
 * visibly accounts for the gap instead of quietly omitting it.
 */

const session = useSessionStore();
const offline = useOfflineStore();

const windows = ref<CheckWindow[]>([]);
const doses = ref<MedicationDose[]>([]);
const signingOff = ref<MedicationDose | null>(null);
const participants = ref<ParticipantSummary[]>([]);
const timeZone = ref(session.timeZone);
const loading = ref(true);
const error = ref('');

const names = computed(
  () => new Map(participants.value.map((one) => [one.id, participantShortName(one)])),
);

function group(predicate: (window: CheckWindow) => boolean): CheckWindow[] {
  return windows.value
    .filter(predicate)
    .sort(
      (a, b) =>
        windowSortRank(a) - windowSortRank(b) ||
        new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
}

const needsAttention = computed(() =>
  group((window) => needsMissReason(window.status, window.missReason !== null)),
);

/**
 * The three remaining groups are in progress, still to come, and finished, and
 * between them they cover every window the feed returns.
 *
 * That exhaustiveness is the point rather than an accident. Grouping on status
 * as well as time leaves gaps: a not-expected window that is open right now
 * matches neither "pending or partial" nor "already closed", so it renders
 * nowhere, and a window silently missing from this screen is exactly what
 * showing not-expected windows greyed is meant to prevent (doc 06 §3).
 */
const dueNow = computed(() =>
  group(
    (window) => new Date(window.startsAt) <= new Date() && new Date(window.endsAt) > new Date(),
  ),
);

const later = computed(() => group((window) => new Date(window.startsAt) > new Date()));

const done = computed(() =>
  group(
    (window) =>
      new Date(window.endsAt) <= new Date() &&
      !needsMissReason(window.status, window.missReason !== null),
  ),
);

/**
 * Read from the device where there is one, and from the server otherwise.
 *
 * "Everything on this screen renders from the local database" (doc 06 §3) is
 * the requirement, and it is what makes the screen open instantly in a house
 * with no signal rather than sitting on a spinner that will never resolve.
 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const today = await readToday();
    windows.value = today.windows;
    timeZone.value = today.timeZone;
    participants.value = today.participants;
    doses.value = (await readDueDoses()).doses;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load today.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// A finished sync means new windows and new statuses, so the screen follows it
// rather than waiting for somebody to pull down.
watch(
  () => offline.lastSyncAt,
  () => void load(),
);

/**
 * Doses still owed an answer, above the checks.
 *
 * Only the open and the missed ones: a dose already signed off belongs on the
 * participant screen, not on the list of what somebody has to do next. A
 * medication that has not been given is more urgent than a check that has not
 * been recorded, so it sits at the top.
 */
function groupDoses(predicate: (dose: MedicationDose) => boolean): MedicationDose[] {
  return doses.value
    .filter(predicate)
    .sort(
      (a, b) =>
        doseSortRank(a) - doseSortRank(b) ||
        new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
    );
}

/** Past its grace period with nobody answering it. The top of the screen. */
const dosesOverdue = computed(() => groupDoses((dose) => dose.status === 'missed'));

const dosesDue = computed(() => groupDoses((dose) => dose.status === 'pending'));

const anyDoses = computed(() => dosesOverdue.value.length + dosesDue.value.length > 0);

async function afterSignOff(): Promise<void> {
  signingOff.value = null;
  await load();
  void offline.sync();
}

const today = computed(() =>
  new Intl.DateTimeFormat('en-AU', {
    timeZone: timeZone.value,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date()),
);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-baseline gap-3">
      <h1 class="text-2xl font-semibold">Today</h1>
      <span class="text-text-secondary">{{ today }}</span>
    </div>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <DoseSignOff
      v-else-if="signingOff"
      :dose="signingOff"
      :participant-id="signingOff.participantId"
      :time-zone="timeZone"
      @saved="afterSignOff"
      @cancel="signingOff = null"
    />

    <div v-else-if="windows.length === 0 && !anyDoses" class="card p-6">
      <p class="font-medium">Nothing due.</p>
      <p class="text-text-secondary mt-1">
        Check windows appear here once a participant you are assigned to has a schedule.
      </p>
    </div>

    <template v-else>
      <section v-if="dosesOverdue.length > 0" class="space-y-2">
        <h2 class="text-state-missed text-lg font-semibold">Medication not signed off</h2>
        <p class="text-text-secondary text-sm">
          These are past their time with nothing recorded against them.
        </p>
        <DoseRow
          v-for="dose in dosesOverdue"
          :key="dose.id"
          :dose="dose"
          :time-zone="timeZone"
          :participant-name="names.get(dose.participantId)"
          @open="signingOff = $event"
        />
      </section>

      <section v-if="dosesDue.length > 0" class="space-y-2">
        <h2 class="text-lg font-semibold">Medication due</h2>
        <DoseRow
          v-for="dose in dosesDue"
          :key="dose.id"
          :dose="dose"
          :time-zone="timeZone"
          :participant-name="names.get(dose.participantId)"
          @open="signingOff = $event"
        />
      </section>

      <section v-if="needsAttention.length > 0" class="space-y-2">
        <h2 class="text-state-missed text-lg font-semibold">Needs attention</h2>
        <p class="text-text-secondary text-sm">
          These closed without a check. Each one needs a reason before it clears.
        </p>
        <WindowRow
          v-for="window in needsAttention"
          :key="window.id"
          :window="window"
          :time-zone="timeZone"
          :participant-name="names.get(window.participantId)"
        />
      </section>

      <section v-if="dueNow.length > 0" class="space-y-2">
        <h2 class="text-lg font-semibold">Due now</h2>
        <WindowRow
          v-for="window in dueNow"
          :key="window.id"
          :window="window"
          :time-zone="timeZone"
          :participant-name="names.get(window.participantId)"
        />
      </section>

      <section v-if="later.length > 0" class="space-y-2">
        <h2 class="text-lg font-semibold">Later</h2>
        <WindowRow
          v-for="window in later"
          :key="window.id"
          :window="window"
          :time-zone="timeZone"
          :participant-name="names.get(window.participantId)"
        />
      </section>

      <section v-if="done.length > 0" class="space-y-2">
        <h2 class="text-lg font-semibold">Done</h2>
        <WindowRow
          v-for="window in done"
          :key="window.id"
          :window="window"
          :time-zone="timeZone"
          :participant-name="names.get(window.participantId)"
        />
      </section>
    </template>
  </div>
</template>
