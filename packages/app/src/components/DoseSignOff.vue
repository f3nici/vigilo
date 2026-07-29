<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  administrationProblem,
  administrationStatuses,
  describeAdministrationStatus,
  describeMedication,
  noteIsRequired,
  witnessIsRequired,
  type AdministrationStatus,
  type Medication,
  type MedicationDose,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import { ApiRequestError, type Colleague } from '@/api/client';
import { readColleagues, recordPrn, signOffDose } from '@/lib/records';
import { useSessionStore } from '@/stores/session';
import { uuidv7 } from '@/lib/uuid';
import { formatWindowTime } from '@/lib/format';

/**
 * Signing off one dose (doc 01 §7.2).
 *
 * The same sheet for a scheduled dose and a PRN one, because a worker is doing
 * the same thing either way: saying what happened to a medication. What differs
 * is what has to be said, and the rules for that come from the shared function
 * rather than from anything decided here, so the phone refuses exactly what the
 * server would refuse and says so at the moment of tapping rather than two
 * hours later when the outbox drains.
 */
const props = defineProps<{
  /** A scheduled dose, or a PRN medication. Exactly one of the two. */
  dose?: MedicationDose | undefined;
  medication?: Medication | undefined;
  participantId: string;
  timeZone: string;
}>();

const emit = defineEmits<{ saved: []; cancel: [] }>();

const session = useSessionStore();

const status = ref<AdministrationStatus>('given');
const note = ref('');
const reason = ref('');
const outcome = ref('');
const witnessedBy = ref('');
const colleagues = ref<Colleague[]>([]);
const saving = ref(false);
const error = ref('');

const isPrn = computed(() => props.dose === undefined);

const requiresWitness = computed(
  () => props.dose?.requiresWitness ?? props.medication?.requiresWitness ?? false,
);

const title = computed(() => {
  if (props.dose) return `${props.dose.medicationName} ${props.dose.dose}`;
  if (props.medication) return describeMedication(props.medication);
  return 'Medication';
});

const instructions = computed(
  () => props.dose?.instructions ?? props.medication?.instructions ?? null,
);

const noteRequired = computed(() => noteIsRequired(status.value));
const witnessRequired = computed(() => witnessIsRequired(status.value, requiresWitness.value));

/**
 * The message the worker will see if they save now, computed as they type
 * rather than on submit. Being told what is missing before pressing the button
 * is the difference between a form that helps and a form that scolds.
 */
const problem = computed(() =>
  administrationProblem({
    status: status.value,
    note: note.value.trim() === '' ? null : note.value,
    witnessedBy: witnessedBy.value === '' ? null : witnessedBy.value,
    requiresWitness: requiresWitness.value,
    recordedBy: session.principal?.userId ?? '',
  }),
);

const prnReasonMissing = computed(() => isPrn.value && reason.value.trim() === '');

const canSave = computed(() => problem.value === null && !prnReasonMissing.value && !saving.value);

onMounted(async () => {
  // Only fetched when a witness could be needed, so the ordinary sign-off does
  // not pull a staff list it will never show.
  if (!requiresWitness.value) return;
  try {
    colleagues.value = await readColleagues();
  } catch {
    // An empty picker, not a broken screen. The sign-off can still be recorded
    // as refused or withheld, which need no witness.
  }
});

async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';

  const now = new Date().toISOString();
  const id = uuidv7();

  try {
    if (props.dose) {
      await signOffDose({
        dose: props.dose,
        request: {
          id,
          status: status.value,
          administeredAt: now,
          recordedAt: now,
          note: note.value.trim() === '' ? null : note.value.trim(),
          witnessedBy: witnessedBy.value === '' ? null : witnessedBy.value,
        },
      });
    } else if (props.medication) {
      await recordPrn({
        participantId: props.participantId,
        medication: props.medication,
        request: {
          id,
          medicationId: props.medication.id,
          status: status.value,
          administeredAt: now,
          recordedAt: now,
          reason: reason.value.trim(),
          outcome: outcome.value.trim() === '' ? null : outcome.value.trim(),
          note: note.value.trim() === '' ? null : note.value.trim(),
          witnessedBy: witnessedBy.value === '' ? null : witnessedBy.value,
        },
      });
    }

    emit('saved');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="card space-y-4 p-4" @submit.prevent="save">
    <div>
      <h3 class="text-lg font-semibold">{{ title }}</h3>
      <p v-if="dose" class="text-text-secondary tabular text-sm">
        Due {{ formatWindowTime(dose.dueAt, timeZone) }}
      </p>
      <p v-else class="text-text-secondary text-sm">As needed</p>
      <p v-if="instructions" class="mt-1 text-sm">{{ instructions }}</p>
    </div>

    <fieldset class="space-y-2">
      <legend class="field-label">What happened</legend>
      <div class="flex flex-wrap gap-2">
        <label
          v-for="one in administrationStatuses"
          :key="one"
          class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
          :style="status === one ? { borderColor: 'var(--vigilo-primary)' } : {}"
        >
          <input v-model="status" type="radio" :value="one" name="status" />
          <span>{{ describeAdministrationStatus(one) }}</span>
        </label>
      </div>
    </fieldset>

    <label v-if="isPrn" class="block space-y-1">
      <span class="field-label">Why it was given</span>
      <textarea v-model="reason" rows="2" class="field" maxlength="2000" required />
    </label>

    <label class="block space-y-1">
      <span class="field-label">
        Note
        <span v-if="noteRequired" class="text-state-missed">(required)</span>
        <span v-else class="text-text-secondary font-normal">(optional)</span>
      </span>
      <textarea v-model="note" rows="2" class="field" maxlength="2000" />
    </label>

    <label v-if="isPrn" class="block space-y-1">
      <span class="field-label">
        Outcome
        <span class="text-text-secondary font-normal">(add it later if you do not know yet)</span>
      </span>
      <textarea v-model="outcome" rows="2" class="field" maxlength="2000" />
    </label>

    <label v-if="requiresWitness" class="block space-y-1">
      <span class="field-label">
        Witness
        <span v-if="witnessRequired" class="text-state-missed">(required)</span>
        <span v-else class="text-text-secondary font-normal">(optional)</span>
      </span>
      <select v-model="witnessedBy" class="field">
        <option value="">Nobody</option>
        <option v-for="one in colleagues" :key="one.id" :value="one.id">
          {{ one.displayName }}
        </option>
      </select>
      <span class="text-text-secondary block text-sm">
        You are recording who witnessed this. They are not asked to sign in.
      </span>
    </label>

    <FormError :message="error" />

    <p v-if="problem" class="text-state-missed text-sm">{{ problem }}</p>
    <p v-else-if="prnReasonMissing" class="text-text-secondary text-sm">Say why this was given.</p>

    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn btn-primary" :disabled="!canSave">
        {{ saving ? 'Saving' : 'Save' }}
      </button>
      <button type="button" class="btn border-border-default border" @click="emit('cancel')">
        Cancel
      </button>
    </div>
  </form>
</template>
