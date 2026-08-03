<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  canManageMedications,
  canSignOffMedication,
  describeAdministrationStatus,
  describeAmountGiven,
  describeMedication,
  doseSortRank,
  localDateOf,
  type Medication,
  type MedicationAdministration,
  type MedicationDose,
} from '@vigilo/shared';
import DoseRow from '@/components/DoseRow.vue';
import DoseSignOff from '@/components/DoseSignOff.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { readAdministrations, readMedications } from '@/lib/records';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';
import { formatDateTimeIn } from '@/lib/format';

/**
 * The medication section of the participant screen (doc 01 §7.2).
 *
 * Three things in one place, because they are one job: what is due today, what
 * the person is on, and what has already been signed off. A worker opening this
 * mid-shift is asking the first question; an auditor is asking the third.
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();
const offline = useOfflineStore();

const doses = ref<MedicationDose[]>([]);
const medications = ref<Medication[]>([]);
const administrations = ref<MedicationAdministration[]>([]);
const timeZone = ref(session.timeZone);
const date = ref(localDateOf(new Date(), session.timeZone));
const signingOff = ref<MedicationDose | null>(null);
const recordingPrn = ref<Medication | null>(null);
const loading = ref(true);
const error = ref('');

const role = computed(() => session.principal?.role ?? 'worker');
const canManage = computed(() => canManageMedications(role.value));
const canSignOff = computed(() => canSignOffMedication(role.value));

const scheduled = computed(() => medications.value.filter((one) => !one.isPrn));
const asNeeded = computed(() => medications.value.filter((one) => one.isPrn));

const ordered = computed(() =>
  [...doses.value].sort(
    (a, b) =>
      doseSortRank(a) - doseSortRank(b) ||
      new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  ),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const day = await api.listDoses(props.participantId, { from: date.value, to: date.value });
    doses.value = day.doses;
    timeZone.value = day.timeZone;
    medications.value = await readMedications(props.participantId);
    administrations.value = await readAdministrations(props.participantId);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load medications.';
  } finally {
    loading.value = false;
  }
}

async function afterSave(): Promise<void> {
  signingOff.value = null;
  recordingPrn.value = null;
  await load();
  void offline.sync();
}

onMounted(load);
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Medication</h2>
      <input v-model="date" type="date" class="field max-w-44" @change="load" />
      <RouterLink
        v-if="canManage"
        class="btn border-border-default ml-auto border"
        :to="{ name: 'participant-medications', params: { id: participantId } }"
      >
        Manage the chart
      </RouterLink>
    </div>

    <FormError :message="error" />
    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <DoseSignOff
        v-if="signingOff"
        :dose="signingOff"
        :participant-id="participantId"
        :time-zone="timeZone"
        @saved="afterSave"
        @cancel="signingOff = null"
      />

      <DoseSignOff
        v-else-if="recordingPrn"
        :medication="recordingPrn"
        :participant-id="participantId"
        :time-zone="timeZone"
        @saved="afterSave"
        @cancel="recordingPrn = null"
      />

      <template v-else>
        <div v-if="doses.length === 0" class="card text-text-secondary p-4">
          Nothing is due on this day.
        </div>
        <DoseRow
          v-for="dose in ordered"
          :key="dose.id"
          :dose="dose"
          :time-zone="timeZone"
          @open="signingOff = $event"
        />

        <div v-if="asNeeded.length > 0" class="space-y-2">
          <h3 class="font-semibold">As needed</h3>
          <div v-for="medication in asNeeded" :key="medication.id" class="card p-3">
            <p class="font-medium">{{ describeMedication(medication) }}</p>
            <p v-if="medication.instructions" class="text-text-secondary mt-1 text-sm">
              {{ medication.instructions }}
            </p>
            <button
              v-if="canSignOff"
              type="button"
              class="btn border-border-default mt-2 border"
              @click="recordingPrn = medication"
            >
              Record a dose
            </button>
          </div>
        </div>

        <details v-if="scheduled.length > 0" class="card p-4">
          <summary class="min-h-11 cursor-pointer font-semibold">
            On the chart ({{ scheduled.length }})
          </summary>
          <ul class="mt-3 space-y-2">
            <li v-for="medication in scheduled" :key="medication.id">
              <p class="font-medium">{{ describeMedication(medication) }}</p>
              <p class="text-text-secondary text-sm">
                {{
                  medication.schedules.length === 0
                    ? 'No times set yet'
                    : medication.schedules.map((one) => one.timeOfDay).join(', ')
                }}
                <span v-if="medication.requiresWitness"> · needs a witness</span>
              </p>
            </li>
          </ul>
        </details>

        <details v-if="administrations.length > 0" class="card p-4">
          <summary class="min-h-11 cursor-pointer font-semibold">
            Signed off recently ({{ administrations.length }})
          </summary>
          <ul class="mt-3 space-y-2 text-sm">
            <li v-for="one in administrations" :key="one.id">
              <span class="tabular">{{ formatDateTimeIn(one.administeredAt, timeZone) }}</span>
              <span class="ml-2 font-medium">
                {{ one.medicationName }} {{ describeAmountGiven(one.dose, one.amountGiven) }}
              </span>
              <span class="text-text-secondary ml-2">
                {{ describeAdministrationStatus(one.status) }}
              </span>
              <span v-if="one.recordedByName" class="text-text-secondary ml-2">
                by {{ one.recordedByName }}
              </span>
              <span v-if="one.witnessedByName" class="text-text-secondary ml-2">
                witnessed by {{ one.witnessedByName }}
              </span>
            </li>
          </ul>
        </details>
      </template>
    </template>
  </section>
</template>
