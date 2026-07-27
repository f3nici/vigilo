<script setup lang="ts">
import { ref } from 'vue';
import {
  alertKinds,
  alertSeverities,
  type AlertKind,
  type AlertSeverity,
  type ParticipantAlert,
} from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * Alerts pinned above everything else for this participant (doc 06 §4.2).
 *
 * Severity drives the colour of the flag and nothing else. It says how urgently
 * a person should read this, never whether something is good or bad.
 */
const props = defineProps<{
  participantId: string;
  alerts: ParticipantAlert[];
  canEdit: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const showForm = ref(false);
const editingId = ref<string | null>(null);
const busy = ref(false);
const error = ref('');

const draft = ref({
  kind: 'medical' as AlertKind,
  severity: 'warning' as AlertSeverity,
  text: '',
});

const kindLabels: Record<AlertKind, string> = {
  allergy: 'Allergy',
  medical: 'Medical',
  behavioural: 'Behavioural',
  communication: 'Communication',
  other: 'Other',
};

const severityColour: Record<AlertSeverity, string> = {
  critical: 'var(--vigilo-missed)',
  warning: 'var(--vigilo-partial)',
  info: 'var(--vigilo-pending)',
};

function startNew(): void {
  editingId.value = null;
  draft.value = { kind: 'medical', severity: 'warning', text: '' };
  showForm.value = true;
}

function startEdit(alert: ParticipantAlert): void {
  editingId.value = alert.id;
  draft.value = { kind: alert.kind, severity: alert.severity, text: alert.text };
  showForm.value = true;
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    if (editingId.value) {
      await api.updateAlert(props.participantId, editingId.value, draft.value);
    } else {
      await api.createAlert(props.participantId, draft.value);
    }
    showForm.value = false;
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that alert.';
  } finally {
    busy.value = false;
  }
}

async function retire(alert: ParticipantAlert): Promise<void> {
  error.value = '';
  try {
    await api.deactivateAlert(props.participantId, alert.id);
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not retire that alert.';
  }
}

async function reinstate(alert: ParticipantAlert): Promise<void> {
  error.value = '';
  try {
    await api.updateAlert(props.participantId, alert.id, { active: true });
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not bring that back.';
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Alerts</h2>
      <button
        v-if="canEdit"
        class="btn border-border-default ml-auto border px-3"
        type="button"
        @click="startNew"
      >
        Add an alert
      </button>
    </div>

    <p v-if="error" class="text-sm" :style="{ color: 'var(--vigilo-missed)' }">{{ error }}</p>

    <form v-if="showForm" class="card space-y-3 p-4" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="alert-kind">Kind</label>
          <select id="alert-kind" v-model="draft.kind" class="field">
            <option v-for="kind in alertKinds" :key="kind" :value="kind">
              {{ kindLabels[kind] }}
            </option>
          </select>
        </div>
        <div>
          <label class="field-label" for="alert-severity">How urgently should this be read</label>
          <select id="alert-severity" v-model="draft.severity" class="field">
            <option v-for="severity in alertSeverities" :key="severity" :value="severity">
              {{
                severity === 'critical'
                  ? 'Read first'
                  : severity === 'warning'
                    ? 'Important'
                    : 'For information'
              }}
            </option>
          </select>
        </div>
      </div>

      <div>
        <label class="field-label" for="alert-text">Alert</label>
        <textarea
          id="alert-text"
          v-model="draft.text"
          class="field"
          rows="2"
          required
          placeholder="Anaphylaxis: peanuts. EpiPen in the kitchen drawer."
        ></textarea>
      </div>

      <div class="flex gap-2">
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? 'Saving' : 'Save alert' }}
        </button>
        <button class="btn border-border-default border" type="button" @click="showForm = false">
          Cancel
        </button>
      </div>
    </form>

    <p v-if="alerts.length === 0" class="text-text-secondary">
      No alerts. {{ canEdit ? 'Add one if there is something everyone needs to see first.' : '' }}
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="alert in alerts"
        :key="alert.id"
        class="card flex flex-wrap items-start gap-x-4 gap-y-2 border-l-4 p-4"
        :style="{ borderLeftColor: severityColour[alert.severity] }"
        :class="alert.active ? '' : 'opacity-60'"
      >
        <div class="min-w-0 flex-1">
          <p class="text-text-secondary text-sm font-semibold">
            {{ kindLabels[alert.kind] }}
            <span v-if="!alert.active">· retired</span>
          </p>
          <p class="mt-1">{{ alert.text }}</p>
        </div>

        <div v-if="canEdit" class="flex gap-2 text-sm">
          <button
            class="btn border-border-default min-h-11 border px-3"
            type="button"
            @click="startEdit(alert)"
          >
            Edit
          </button>
          <button
            v-if="alert.active"
            class="btn btn-destructive min-h-11 px-3"
            type="button"
            @click="retire(alert)"
          >
            Retire
          </button>
          <button
            v-else
            class="btn border-border-default min-h-11 border px-3"
            type="button"
            @click="reinstate(alert)"
          >
            Bring back
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
