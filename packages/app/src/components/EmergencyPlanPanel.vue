<script setup lang="ts">
import { ref } from 'vue';
import type { EmergencyPlan } from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDateTime } from '@/lib/format';

/**
 * The emergency plan. One per participant, and it has to be readable offline
 * at all times (doc 03 §3), which is why it lives on the record rather than
 * being fetched when someone goes looking for it.
 */
const props = defineProps<{
  participantId: string;
  plan: EmergencyPlan | null;
  canEdit: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const editing = ref(false);
const busy = ref(false);
const error = ref('');
const draft = ref({ title: '', body: '' });

function start(): void {
  draft.value = {
    title: props.plan?.title ?? 'Emergency plan',
    body: props.plan?.body ?? '',
  };
  editing.value = true;
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.putEmergencyPlan(props.participantId, {
      title: draft.value.title.trim(),
      body: draft.value.body.trim(),
    });
    editing.value = false;
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the plan.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Emergency plan</h2>
      <button
        v-if="canEdit && !editing"
        class="btn border-border-default ml-auto border px-3"
        type="button"
        @click="start"
      >
        {{ plan ? 'Edit plan' : 'Write the plan' }}
      </button>
    </div>

    <p v-if="error" class="text-sm" :style="{ color: 'var(--vigilo-missed)' }">{{ error }}</p>

    <form v-if="editing" class="card space-y-3 p-4" @submit.prevent="save">
      <div>
        <label class="field-label" for="plan-title">Title</label>
        <input id="plan-title" v-model="draft.title" class="field" type="text" required />
      </div>
      <div>
        <label class="field-label" for="plan-body">What to do</label>
        <textarea id="plan-body" v-model="draft.body" class="field" rows="8" required></textarea>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? 'Saving' : 'Save plan' }}
        </button>
        <button class="btn border-border-default border" type="button" @click="editing = false">
          Cancel
        </button>
      </div>
    </form>

    <div v-else-if="plan" class="card p-4">
      <p class="font-semibold">{{ plan.title }}</p>
      <p class="mt-2 whitespace-pre-wrap">{{ plan.body }}</p>
      <p class="text-text-secondary mt-3 text-sm">
        Last changed {{ formatDateTime(plan.updatedAt) }}
      </p>
    </div>

    <p v-else class="text-text-secondary">
      No emergency plan yet.
      {{ canEdit ? '' : 'An admin or nurse writes this one.' }}
    </p>
  </section>
</template>
