<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  describeWindowStatus,
  missReasonProblem,
  missingRequiredKeys,
  needsMissReason,
  templateSchemaSchema,
  validateValues,
  type CheckValue,
  type EntryRevision,
  type MissedReasonCode,
  type TemplateSchema,
  type WindowDetail,
} from '@vigilo/shared';
import DynamicForm from '@/components/DynamicForm.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { closesIn, formatDateTime, formatWindowRange } from '@/lib/format';

/**
 * Recording a check (doc 06 §4.3).
 *
 * Rules this screen keeps:
 *
 * - Partial entry is expected. It says how many required fields remain instead
 *   of blocking the save.
 * - A closed window still opens, with a plain banner saying the entry will be
 *   recorded as late.
 * - No value is coloured or flagged, ever.
 * - An edited value shows as edited, with the history one tap away, and the
 *   original is never quietly replaced.
 */
const route = useRoute();

const windowId = computed(() => route.params.id as string);
const timeZone = computed(() => route.query.tz?.toString() ?? 'Australia/Melbourne');

const detail = ref<WindowDetail | null>(null);
const values = ref<Record<string, CheckValue>>({});
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const savedAt = ref('');

const reasonCodes = ref<MissedReasonCode[]>([]);
const chosenReason = ref('');
const reasonNote = ref('');

const revisions = ref<EntryRevision[]>([]);
const showHistory = ref(false);

/** A device-generated UUID v7 would come from the outbox in Phase 5. */
const entryId = ref<string>(crypto.randomUUID());

const schema = computed<TemplateSchema>(() => {
  const parsed = templateSchemaSchema.safeParse(detail.value?.templateSchema);
  return parsed.success ? parsed.data : { fields: [] };
});

const dirtyValues = computed(() => Object.values(values.value));
const problems = computed(() => validateValues(schema.value, dirtyValues.value));
const remaining = computed(() => missingRequiredKeys(schema.value, dirtyValues.value));

const isClosed = computed(
  () => detail.value !== null && new Date(detail.value.endsAt) <= new Date(),
);

const needsReason = computed(
  () =>
    detail.value !== null && needsMissReason(detail.value.status, detail.value.missReason !== null),
);

const selectedCode = computed(() =>
  reasonCodes.value.find((code) => code.id === chosenReason.value),
);

const reasonProblem = computed(() =>
  selectedCode.value ? missReasonProblem(selectedCode.value, reasonNote.value) : null,
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [window, codes] = await Promise.all([
      api.getWindow(windowId.value),
      api.listReasonCodes(),
    ]);
    detail.value = window;
    reasonCodes.value = codes;

    const entry = window.entry as { id: string; values: CheckValue[] } | null;
    if (entry) {
      entryId.value = entry.id;
      values.value = Object.fromEntries(
        entry.values.map((value) => [value.fieldKey, { ...value }]),
      );
    } else {
      values.value = {};
    }

    if (window.missReason) {
      chosenReason.value = window.missReason.reasonCodeId;
      reasonNote.value = window.missReason.note ?? '';
    }
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open that window.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function onChange(value: CheckValue): void {
  values.value = { ...values.value, [value.fieldKey]: value };
}

/**
 * Filling the rest of a part-recorded check is still the same entry, not an
 * edit (doc 01 §5.5). A worker who fills two fields now and three later has
 * recorded one check, so that goes through the upsert and writes no revisions.
 *
 * Once every required field has a value, the check has been made, and anything
 * further is a change to a clinical record: that goes through the edit path and
 * is preserved with the old value, who changed it and when.
 */
const isEdit = computed(() => detail.value?.entryStatus === 'complete');

async function save(): Promise<void> {
  if (detail.value === null || problems.value.length > 0) return;
  saving.value = true;
  error.value = '';
  try {
    const payload = dirtyValues.value.map((value) => ({
      fieldKey: value.fieldKey,
      ...(value.number === undefined ? {} : { number: value.number }),
      ...(value.bool === undefined ? {} : { bool: value.bool }),
      ...(value.text === undefined ? {} : { text: value.text }),
      ...(value.json === undefined ? {} : { json: value.json }),
    }));

    detail.value = isEdit.value
      ? await api.editEntry(entryId.value, { values: payload })
      : await api.putEntry(windowId.value, {
          entryId: entryId.value,
          templateVersionId: detail.value.templateVersionId,
          recordedAt: new Date().toISOString(),
          values: payload,
        });

    savedAt.value = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    if (showHistory.value) await loadHistory();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the check.';
  } finally {
    saving.value = false;
  }
}

async function saveReason(): Promise<void> {
  if (chosenReason.value === '' || reasonProblem.value !== null) return;
  saving.value = true;
  error.value = '';
  try {
    detail.value = await api.putMissReason(windowId.value, {
      reasonCodeId: chosenReason.value,
      note: reasonNote.value.trim() === '' ? null : reasonNote.value,
    });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not record the reason.';
  } finally {
    saving.value = false;
  }
}

async function loadHistory(): Promise<void> {
  if (detail.value?.entryId === null || detail.value?.entryId === undefined) return;
  try {
    revisions.value = await api.listEntryRevisions(detail.value.entryId);
    showHistory.value = true;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the history.';
  }
}

function describeRevisionValue(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  const holder = value as {
    number?: number | null;
    bool?: boolean | null;
    text?: string | null;
    json?: unknown;
  };
  if (holder.number !== null && holder.number !== undefined) return String(holder.number);
  if (holder.bool !== null && holder.bool !== undefined) return holder.bool ? 'Yes' : 'No';
  if (holder.text !== null && holder.text !== undefined) return holder.text;
  if (holder.json !== null && holder.json !== undefined) {
    return Array.isArray(holder.json) ? holder.json.join(', ') : String(holder.json);
  }
  return 'empty';
}
</script>

<template>
  <div class="space-y-5">
    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else-if="detail">
      <div class="flex flex-wrap items-center gap-3">
        <RouterLink
          :to="{ name: 'participant', params: { id: detail.participantId } }"
          class="text-primary"
        >
          ← Participant
        </RouterLink>
        <h1 class="text-2xl font-semibold">{{ detail.scheduleName }}</h1>
      </div>

      <p class="text-text-secondary tabular">
        Window {{ formatWindowRange(detail.startsAt, detail.endsAt, timeZone) }} ·
        {{ closesIn(detail.endsAt) }} · {{ describeWindowStatus(detail.status) }}
      </p>

      <FormError :message="error" />

      <!-- Doc 06 §4.3: the closed window still opens, and says what will happen. -->
      <div v-if="isClosed" class="card p-4" :style="{ borderColor: 'var(--vigilo-late)' }">
        <p :style="{ color: 'var(--vigilo-late)' }" class="font-medium">
          This window closed at
          {{ formatWindowRange(detail.startsAt, detail.endsAt, timeZone).split('–')[1] }}. Anything
          you record now is kept, and marked as late.
        </p>
        <p v-if="detail.backfillNeedsApproval" class="text-text-secondary mt-1 text-sm">
          It closed more than a day ago, so a team leader or nurse has to record it.
        </p>
      </div>

      <div
        v-if="!detail.expected"
        class="card p-4"
        :style="{ borderColor: 'var(--vigilo-not-expected)' }"
      >
        <p class="font-medium">Not expected: {{ detail.coverageReason }}</p>
        <p class="text-text-secondary mt-1 text-sm">
          Nothing is owed for this window and it is not counted as missed. If you are here anyway,
          record it and it counts as done.
        </p>
      </div>

      <!-- The missed-window prompt sits above the form until it is answered. -->
      <section
        v-if="needsReason"
        class="card space-y-3 p-4"
        :style="{ borderColor: 'var(--vigilo-missed)' }"
      >
        <h2 class="text-lg font-semibold">Why was this check missed?</h2>
        <p class="text-text-secondary text-sm">
          This stays at the top of the participant until someone answers it.
        </p>

        <div>
          <label class="field-label" for="miss-reason">Reason</label>
          <select id="miss-reason" v-model="chosenReason" class="field">
            <option value="">Choose a reason…</option>
            <option v-for="code in reasonCodes" :key="code.id" :value="code.id">
              {{ code.label }}
            </option>
          </select>
        </div>

        <div>
          <label class="field-label" for="miss-note">
            Note{{ selectedCode?.requiresNote ? '' : ' (optional)' }}
          </label>
          <textarea id="miss-note" v-model="reasonNote" class="field min-h-20" />
          <p v-if="reasonProblem" class="text-state-missed mt-1 text-sm">{{ reasonProblem }}</p>
        </div>

        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving || chosenReason === '' || reasonProblem !== null"
          @click="saveReason"
        >
          Record the reason
        </button>
      </section>

      <p v-else-if="detail.missReason" class="text-text-secondary">
        Missed. Reason: {{ detail.missReason.label
        }}<span v-if="detail.missReason.note">, "{{ detail.missReason.note }}"</span>, recorded by
        {{ detail.missReason.recordedByName ?? 'someone' }}.
      </p>

      <section class="card p-4">
        <DynamicForm :schema="schema" :values="values" @change="onChange" />
      </section>

      <div class="card flex flex-wrap items-center gap-3 p-4">
        <p class="text-text-secondary text-sm">
          <span v-if="savedAt">Saved {{ savedAt }}.</span>
          <span v-if="remaining.length > 0">
            {{ remaining.length }} required {{ remaining.length === 1 ? 'field' : 'fields' }} still
            to fill. You can save what you have and come back.
          </span>
          <span v-else>Everything required is filled.</span>
        </p>

        <button
          type="button"
          class="btn btn-primary ml-auto"
          :disabled="saving || problems.length > 0 || dirtyValues.length === 0"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>

      <section v-if="detail.entryId" class="card p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">Record</h2>
          <button
            type="button"
            class="btn border-border-default ml-auto border"
            @click="loadHistory"
          >
            Show edit history
          </button>
        </div>

        <ul v-if="showHistory && revisions.length > 0" class="mt-3 space-y-2 text-sm">
          <li
            v-for="revision in revisions"
            :key="revision.id"
            class="border-border-default rounded-lg border p-2"
          >
            <span class="font-medium">{{ revision.fieldKey }}</span>
            changed from {{ describeRevisionValue(revision.oldValue) }} to
            {{ describeRevisionValue(revision.newValue) }}
            by {{ revision.changedByName ?? 'someone' }} on {{ formatDateTime(revision.changedAt)
            }}<span v-if="revision.reason">, "{{ revision.reason }}"</span>.
          </li>
        </ul>

        <p v-else-if="showHistory" class="text-text-secondary mt-3 text-sm">
          Nothing has been edited since it was first recorded.
        </p>
      </section>
    </template>
  </div>
</template>
