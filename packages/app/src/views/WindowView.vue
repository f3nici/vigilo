<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
import { readReasonCodes, readWindow, recordEntry, recordMissReason } from '@/lib/records';
import { uuidv7 } from '@/lib/uuid';
import { entryInProgress } from '@/sw/register';
import { needs, needsChoice, useFormGuard } from '@/lib/forms';

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

/**
 * Device-generated, and a UUID v7 rather than a v4 (CLAUDE.md).
 *
 * This id is what makes the save idempotent: the same entry replayed after a
 * dropped connection updates one row on the server instead of creating a
 * second check nobody made.
 */
const entryId = ref<string>(uuidv7());

/** Set while there is unsaved input, so a service worker update waits. */
const queued = ref(false);

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
    const [window, codes] = await Promise.all([readWindow(windowId.value), readReasonCodes()]);
    if (!window) {
      error.value = 'That check window is not on this device.';
      return;
    }
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
  // Half-typed observations are exactly what a service worker update must not
  // interrupt (doc 06 §7).
  entryInProgress.value = true;
}

onUnmounted(() => {
  entryInProgress.value = false;
});

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

const guard = useFormGuard();

async function save(): Promise<void> {
  if (detail.value === null || saving.value) return;
  if (
    !guard.ready(
      needs('check-form', problems.value.length === 0, problems.value[0]?.message ?? ''),
      needs(
        'check-form',
        dirtyValues.value.length > 0,
        'Nothing has been filled in yet, so there is nothing to save.',
      ),
    )
  ) {
    return;
  }
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

    if (isEdit.value) {
      // An edit to a completed check goes to the server, because it writes a
      // revision row against a record the server already holds. Offline, that
      // is a genuine limit rather than something to queue and hope about.
      detail.value = await api.editEntry(entryId.value, { values: payload });
      queued.value = false;
    } else {
      const result = await recordEntry({
        window: detail.value,
        entryId: entryId.value,
        values: payload,
      });
      detail.value = result.detail;
      queued.value = result.queued;
    }

    entryInProgress.value = false;
    savedAt.value = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    if (showHistory.value && !queued.value) await loadHistory();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the check.';
  } finally {
    saving.value = false;
  }
}

async function saveReason(): Promise<void> {
  if (
    !guard.ready(
      needsChoice('miss-reason', chosenReason.value, 'Choose why this check was missed.'),
      needs('miss-note', reasonProblem.value === null, reasonProblem.value ?? ''),
    )
  ) {
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    if (detail.value === null) return;
    const result = await recordMissReason({
      window: detail.value,
      request: {
        reasonCodeId: chosenReason.value,
        note: reasonNote.value.trim() === '' ? null : reasonNote.value,
      },
    });
    detail.value = result.detail;
    queued.value = result.queued;
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

      <FormError :message="guard.problem.value?.message ?? error" />

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
          <select
            id="miss-reason"
            v-model="chosenReason"
            class="field"
            :aria-invalid="guard.invalid('miss-reason')"
            @change="guard.clear()"
          >
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

        <button type="button" class="btn btn-primary" :disabled="saving" @click="saveReason">
          Record the reason
        </button>
      </section>

      <p v-else-if="detail.missReason" class="text-text-secondary">
        Missed. Reason: {{ detail.missReason.label
        }}<span v-if="detail.missReason.note">, "{{ detail.missReason.note }}"</span>, recorded by
        {{ detail.missReason.recordedByName ?? 'someone' }}.
      </p>

      <!-- `tabindex` so a save that complains can put focus back on the form. -->
      <section id="check-form" class="card p-4" tabindex="-1">
        <DynamicForm :schema="schema" :values="values" @change="onChange" />
      </section>

      <div class="card flex flex-wrap items-center gap-3 p-4">
        <p class="text-text-secondary text-sm">
          <!--
            Doc 06 §4.3 shows exactly this: "Saved locally 09:14 · will sync".
            A worker needs to know the record is on the phone and safe, not be
            left wondering whether it went anywhere.
          -->
          <span v-if="savedAt && queued">Saved on this device {{ savedAt }}, will sync. </span>
          <span v-else-if="savedAt">Saved {{ savedAt }}. </span>
          <span v-if="remaining.length > 0">
            {{ remaining.length }} required {{ remaining.length === 1 ? 'field' : 'fields' }} still
            to fill. You can save what you have and come back.
          </span>
          <span v-else>Everything required is filled.</span>
        </p>

        <button type="button" class="btn btn-primary ml-auto" :disabled="saving" @click="save">
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
