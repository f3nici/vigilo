<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { describeMedication, describeWeekdays, localDateOf, type Medication } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDate } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

/**
 * The medication chart, for an admin or a nurse (doc 01 §7.2).
 *
 * Deciding what somebody takes is a clinical judgement, which is why this
 * screen is behind the same permission as authoring a care plan and not behind
 * the one for setting up check schedules.
 *
 * Nothing here deletes. A medication that has stopped is marked stopped with an
 * end date, so the doses already signed off against it stay readable and the
 * record of what somebody was taking in March stays true in June.
 */

const session = useSessionStore();
const route = useRoute();
const participantId = computed(() => String(route.params.id));

const medications = ref<Medication[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const adding = ref(false);
const form = ref(blankForm());

/** The medication whose due times are open for editing, if any. */
const editingTimes = ref<string | null>(null);
const times = ref<string[]>([]);

function blankForm() {
  return {
    name: '',
    form: '',
    dose: '',
    route: '',
    instructions: '',
    isPrn: false,
    requiresWitness: false,
    startDate: localDateOf(new Date(), session.timeZone),
    endDate: '',
  };
}

const active = computed(() => medications.value.filter((one) => one.active));
const stopped = computed(() => medications.value.filter((one) => !one.active));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    medications.value = await api.listMedications(participantId.value, { includeInactive: true });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the chart.';
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await api.createMedication(participantId.value, {
      name: form.value.name.trim(),
      form: form.value.form.trim() === '' ? null : form.value.form.trim(),
      dose: form.value.dose.trim(),
      route: form.value.route.trim() === '' ? null : form.value.route.trim(),
      instructions: form.value.instructions.trim() === '' ? null : form.value.instructions.trim(),
      isPrn: form.value.isPrn,
      requiresWitness: form.value.requiresWitness,
      startDate: form.value.startDate,
      endDate: form.value.endDate === '' ? null : form.value.endDate,
    });
    adding.value = false;
    form.value = blankForm();
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}

function openTimes(medication: Medication): void {
  editingTimes.value = medication.id;
  times.value = medication.schedules.map((one) => one.timeOfDay);
  if (times.value.length === 0) times.value = ['08:00'];
}

async function saveTimes(): Promise<void> {
  if (editingTimes.value === null) return;
  saving.value = true;
  error.value = '';
  try {
    await api.putMedicationSchedules(editingTimes.value, {
      schedules: times.value
        .filter((one) => one !== '')
        .map((timeOfDay) => ({ timeOfDay, weekdays: null, activeFrom: null, activeTo: null })),
    });
    editingTimes.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Those times could not be saved.';
  } finally {
    saving.value = false;
  }
}

/**
 * Stopping a medication, rather than deleting it. The doses still ahead are
 * cleared by the server; everything already signed off stays exactly where it
 * is.
 */
async function stop(medication: Medication): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await api.updateMedication(medication.id, {
      active: false,
      endDate: localDateOf(new Date(), session.timeZone),
    });
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be stopped.';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-baseline gap-3">
      <h1 class="text-2xl font-semibold">Medication chart</h1>
      <RouterLink
        class="text-text-secondary ml-auto underline"
        :to="{ name: 'participant', params: { id: participantId } }"
      >
        Back to the participant
      </RouterLink>
    </div>

    <p class="text-text-secondary">
      Vigilo records what was given and what was not. It does not check doses, interactions or
      totals, and it never will.
    </p>

    <FormError :message="error" />
    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <button v-if="!adding" type="button" class="btn btn-primary" @click="adding = true">
        Add a medication
      </button>

      <form v-else class="card space-y-4 p-4" @submit.prevent="create">
        <h2 class="text-lg font-semibold">New medication</h2>

        <div class="grid gap-4 sm:grid-cols-2">
          <label>
            <span class="field-label">Name</span>
            <input v-model="form.name" class="field" maxlength="160" required />
          </label>
          <label>
            <span class="field-label">Dose</span>
            <input
              v-model="form.dose"
              class="field"
              maxlength="100"
              required
              placeholder="250 mg, half a sachet, 2 puffs"
            />
          </label>
          <label>
            <span class="field-label">Form</span>
            <input v-model="form.form" class="field" maxlength="60" placeholder="tablet" />
          </label>
          <label>
            <span class="field-label">Route</span>
            <input v-model="form.route" class="field" maxlength="60" placeholder="oral" />
          </label>
          <label>
            <span class="field-label">Starts</span>
            <input v-model="form.startDate" type="date" class="field" required />
          </label>
          <label>
            <span class="field-label">Ends (optional)</span>
            <input v-model="form.endDate" type="date" class="field" />
          </label>
        </div>

        <label>
          <span class="field-label">Instructions (optional)</span>
          <textarea v-model="form.instructions" rows="2" class="field" maxlength="2000" />
        </label>

        <label class="flex items-start gap-3">
          <input v-model="form.isPrn" type="checkbox" class="mt-1 h-5 w-5" />
          <span>
            <span class="font-medium">Given as needed (PRN)</span>
            <span class="text-text-secondary block text-sm">
              No scheduled times. Recorded ad hoc with a reason.
            </span>
          </span>
        </label>

        <label class="flex items-start gap-3">
          <input v-model="form.requiresWitness" type="checkbox" class="mt-1 h-5 w-5" />
          <span>
            <span class="font-medium">Needs a second person to witness the dose</span>
            <span class="text-text-secondary block text-sm">
              Asked for when a dose is signed off as given.
            </span>
          </span>
        </label>

        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? 'Saving' : 'Save' }}
          </button>
          <button
            type="button"
            class="btn border-border-default border"
            @click="
              adding = false;
              form = blankForm();
            "
          >
            Cancel
          </button>
        </div>
      </form>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">On the chart</h2>

        <p v-if="active.length === 0" class="card text-text-secondary p-4">
          Nothing on the chart yet.
        </p>

        <article v-for="medication in active" :key="medication.id" class="card space-y-2 p-4">
          <div class="flex flex-wrap items-baseline gap-2">
            <p class="font-semibold">{{ describeMedication(medication) }}</p>
            <span v-if="medication.isPrn" class="text-text-secondary text-sm">As needed</span>
            <span v-if="medication.requiresWitness" class="text-text-secondary text-sm">
              · needs a witness
            </span>
            <span class="text-text-secondary ml-auto text-sm">
              from {{ formatDate(medication.startDate) }}
              <template v-if="medication.endDate">
                to {{ formatDate(medication.endDate) }}
              </template>
            </span>
          </div>

          <p v-if="medication.instructions" class="text-sm">{{ medication.instructions }}</p>

          <template v-if="!medication.isPrn">
            <div v-if="editingTimes === medication.id" class="space-y-2">
              <span class="field-label">Due times</span>
              <div
                v-for="(_, index) in times"
                :key="index"
                class="flex flex-wrap items-center gap-2"
              >
                <input v-model="times[index]" type="time" class="field max-w-40" />
                <button
                  type="button"
                  class="btn border-border-default border"
                  @click="times.splice(index, 1)"
                >
                  Remove
                </button>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="btn border-border-default border"
                  @click="times.push('08:00')"
                >
                  Add a time
                </button>
                <button type="button" class="btn btn-primary" :disabled="saving" @click="saveTimes">
                  Save times
                </button>
                <button
                  type="button"
                  class="btn border-border-default border"
                  @click="editingTimes = null"
                >
                  Cancel
                </button>
              </div>
              <p class="text-text-secondary text-sm">
                Doses are laid out a week ahead, so a phone with no signal still knows what is due.
              </p>
            </div>

            <div v-else class="flex flex-wrap items-center gap-3">
              <p class="text-text-secondary tabular text-sm">
                {{
                  medication.schedules.length === 0
                    ? 'No times set, so nothing is due'
                    : medication.schedules.map((one) => one.timeOfDay).join(', ')
                }}
                <span v-if="medication.schedules.length > 0" class="ml-1">
                  · {{ describeWeekdays(medication.schedules[0]?.weekdays ?? null) }}
                </span>
              </p>
              <button
                type="button"
                class="btn border-border-default border"
                @click="openTimes(medication)"
              >
                Change the times
              </button>
            </div>
          </template>

          <button
            type="button"
            class="btn btn-destructive"
            :disabled="saving"
            @click="stop(medication)"
          >
            Stop this medication
          </button>
        </article>
      </section>

      <section v-if="stopped.length > 0" class="space-y-3">
        <h2 class="text-lg font-semibold">Stopped</h2>
        <p class="text-text-secondary text-sm">
          Kept, not deleted, so what somebody was taking at the time stays readable.
        </p>
        <article v-for="medication in stopped" :key="medication.id" class="card p-4 opacity-70">
          <p class="font-semibold">{{ describeMedication(medication) }}</p>
          <p class="text-text-secondary text-sm">
            {{ formatDate(medication.startDate) }}
            <template v-if="medication.endDate"> to {{ formatDate(medication.endDate) }}</template>
          </p>
        </article>
      </section>
    </template>
  </div>
</template>
