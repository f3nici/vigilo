<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  participantDisplayName,
  type ParticipantFormChoice,
  type ParticipantSummary,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { readParticipant } from '@/lib/records';

/**
 * Which check forms apply to this participant (D94).
 *
 * Recording a check on demand used to offer every published form in the org.
 * For a team running a bowel chart, a seizure record and two observation
 * forms, a worker recording something for somebody who only ever needs one of
 * them had three chances to pick the wrong one, and the list grew every time
 * the org wrote another form.
 *
 * This is not a permission. Everything here is already inside the
 * participant's record; ticking a form decides what the picker offers, and
 * nothing else.
 */
const route = useRoute();

const participantId = computed(() => String(route.params.id ?? ''));

const participant = ref<ParticipantSummary | null>(null);
const forms = ref<ParticipantFormChoice[]>([]);
const chosen = ref(new Set<string>());
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

/**
 * A form on this participant's schedule is theirs already, by a stronger route
 * than a tick. It shows as on and cannot be turned off here, because unticking
 * it would not stop the windows arriving and the screen would be lying.
 */
const scheduled = ref(new Set<string>());

function adopt(list: ParticipantFormChoice[]): void {
  forms.value = list;
  chosen.value = new Set(list.filter((form) => form.assigned).map((form) => form.id));
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [detail, list, recordable] = await Promise.all([
      readParticipant(participantId.value),
      api.listParticipantFormChoices(participantId.value),
      api.listRecordableForms(participantId.value),
    ]);
    participant.value = detail.participant;
    adopt(list);

    // The recordable list is the union of ticked and scheduled, so anything in
    // it that is not ticked is there because of a schedule.
    const ticked = new Set(list.filter((form) => form.assigned).map((form) => form.id));
    scheduled.value = new Set(
      recordable.filter((form) => !ticked.has(form.id)).map((form) => form.id),
    );
    for (const id of scheduled.value) chosen.value.add(id);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open that screen.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function toggle(id: string): void {
  if (scheduled.value.has(id)) return;
  const next = new Set(chosen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosen.value = next;
  saved.value = false;
}

const changed = computed(() => {
  const before = new Set(forms.value.filter((form) => form.assigned).map((form) => form.id));
  if (before.size !== chosen.value.size) return true;
  for (const id of chosen.value) if (!before.has(id)) return true;
  return false;
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    adopt(await api.setParticipantForms(participantId.value, [...chosen.value]));
    for (const id of scheduled.value) chosen.value.add(id);
    saved.value = true;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <RouterLink :to="{ name: 'participant', params: { id: participantId } }" class="text-primary">
        ← {{ participant ? participantDisplayName(participant) : 'Participant' }}
      </RouterLink>
      <h1 class="text-2xl font-semibold">Which check forms apply</h1>
    </div>

    <p class="text-text-secondary">
      Tick the forms this person actually needs. A worker recording a check on demand is offered
      these and nothing else. It does not change what anybody is allowed to see.
    </p>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <p v-else-if="forms.length === 0" class="card text-text-secondary p-4">
      There are no check forms yet. An admin or a nurse writes one under Check forms.
    </p>

    <template v-else>
      <ul class="card divide-border-default divide-y">
        <li v-for="form in forms" :key="form.id" class="flex items-start gap-3 p-4">
          <input
            :id="`form-${form.id}`"
            type="checkbox"
            class="mt-1 h-5 w-5 shrink-0"
            :checked="chosen.has(form.id)"
            :disabled="scheduled.has(form.id)"
            @change="toggle(form.id)"
          />
          <label :for="`form-${form.id}`" class="min-w-0 flex-1">
            <span class="font-medium">{{ form.name }}</span>
            <span v-if="form.description" class="text-text-secondary block text-sm">
              {{ form.description }}
            </span>
            <span v-if="scheduled.has(form.id)" class="text-text-secondary block text-sm">
              On this person's schedule, so it is always available.
            </span>
            <!--
              A draft form can be ticked now and starts working the moment it
              is published. Saying so beats leaving somebody to wonder why the
              form they just ticked is not in the picker.
            -->
            <span v-else-if="!form.recordable" class="text-text-secondary block text-sm">
              Not published yet. Ticking it now means it appears as soon as it is.
            </span>
          </label>
        </li>
      </ul>

      <div class="card flex flex-wrap items-center gap-3 p-4">
        <p class="text-text-secondary text-sm">
          {{ chosen.size }} of {{ forms.length }} ticked.
          <span v-if="saved && !changed">Saved.</span>
        </p>
        <button type="button" class="btn btn-primary ml-auto" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </div>
</template>
