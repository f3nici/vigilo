<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  missReasonProblem,
  type CheckWindow,
  type MissedReasonCode,
  type PutMissReasonRequest,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import { ApiRequestError } from '@/api/client';
import { recordMissReasonFor } from '@/lib/records';
import { needs, needsChoice, useFormGuard } from '@/lib/forms';
import { formatDayHeading, formatWindowRange } from '@/lib/format';

/**
 * One reason, given to a run of missed checks at once (#19).
 *
 * A check form left switched on by mistake produces a missed window every two
 * hours until somebody notices, and each one has to be answered before it
 * clears. Answering forty of them one at a time is how a reason stops meaning
 * anything, so this gives the same reason to the ones that were missed for the
 * same cause, and each window is still written individually: same route, same
 * audit entry, same offline queue as answering them by hand.
 *
 * Every window is ticked to start with and each can be unticked, because "all
 * of these except that one" is the common case and a bulk action nobody can
 * narrow is one people work around.
 */
const props = defineProps<{
  windows: CheckWindow[];
  reasonCodes: MissedReasonCode[];
  timeZone: string;
  /** Shown per row on Today, where one list can span participants. */
  names?: Map<string, string>;
}>();

const emit = defineEmits<{ done: []; cancel: [] }>();

const chosen = ref<Set<string>>(new Set(props.windows.map((window) => window.id)));
const reasonCodeId = ref('');
const note = ref('');
const saving = ref(false);
const error = ref('');
const guard = useFormGuard();

const selectedCode = computed(() =>
  props.reasonCodes.find((code) => code.id === reasonCodeId.value),
);

const reasonProblem = computed(() =>
  selectedCode.value ? missReasonProblem(selectedCode.value, note.value) : null,
);

const selectedCount = computed(() => chosen.value.size);

function isChosen(id: string): boolean {
  return chosen.value.has(id);
}

function toggle(id: string): void {
  const next = new Set(chosen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosen.value = next;
  guard.clear();
}

function selectAll(): void {
  chosen.value = new Set(props.windows.map((window) => window.id));
  guard.clear();
}

function selectNone(): void {
  chosen.value = new Set();
}

function describe(window: CheckWindow): string {
  return `${formatDayHeading(window.startsAt, props.timeZone)}, ${formatWindowRange(
    window.startsAt,
    window.endsAt,
    props.timeZone,
  )}`;
}

/**
 * One write per window, sequentially.
 *
 * Sequential rather than in parallel because offline these are outbox rows and
 * online this is forty requests: a worker's phone on a house connection is not
 * the place to open forty at once. A window that fails is named and the rest
 * still go through, so a bulk answer never half-fails silently.
 */
async function save(): Promise<void> {
  if (saving.value) return;
  if (
    !guard.ready(
      needs('bulk-list', selectedCount.value > 0, 'Tick at least one check to answer.'),
      needsChoice('bulk-reason', reasonCodeId.value, 'Choose why these checks were missed.'),
      needs('bulk-note', reasonProblem.value === null, reasonProblem.value ?? ''),
    )
  ) {
    return;
  }

  saving.value = true;
  error.value = '';

  const request: PutMissReasonRequest = {
    reasonCodeId: reasonCodeId.value,
    note: note.value.trim() === '' ? null : note.value.trim(),
  };

  const failed: string[] = [];
  for (const window of props.windows) {
    if (!chosen.value.has(window.id)) continue;
    try {
      await recordMissReasonFor({
        windowId: window.id,
        participantId: window.participantId,
        request,
      });
    } catch (err) {
      failed.push(
        `${describe(window)}: ${err instanceof ApiRequestError ? err.message : 'could not be saved'}`,
      );
    }
  }

  saving.value = false;

  if (failed.length > 0) {
    error.value = `${failed.length} of ${selectedCount.value} could not be answered. ${failed[0] ?? ''}`;
    return;
  }

  emit('done');
}
</script>

<template>
  <section class="card space-y-3 p-4" :style="{ borderColor: 'var(--vigilo-missed)' }">
    <h3 class="text-lg font-semibold">Give one reason to several checks</h3>
    <p class="text-text-secondary text-sm">
      Each one is recorded separately against the check it answers, exactly as if it had been
      answered on its own.
    </p>

    <FormError :message="guard.problem.value?.message ?? error" />

    <div>
      <div class="flex flex-wrap items-baseline gap-3">
        <p class="field-label">
          {{ selectedCount }} of {{ windows.length }}
          {{ windows.length === 1 ? 'check' : 'checks' }}
        </p>
        <div class="ml-auto flex gap-3 text-sm">
          <button type="button" class="text-primary underline" @click="selectAll">Tick all</button>
          <button type="button" class="text-primary underline" @click="selectNone">
            Untick all
          </button>
        </div>
      </div>

      <ul
        id="bulk-list"
        class="border-border-default mt-2 max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2"
        tabindex="-1"
      >
        <li v-for="window in windows" :key="window.id">
          <label class="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              class="size-5"
              :checked="isChosen(window.id)"
              @change="toggle(window.id)"
            />
            <span>
              <span v-if="names?.get(window.participantId)" class="font-semibold">
                {{ names.get(window.participantId) }} ·
              </span>
              <span class="tabular">{{ describe(window) }}</span>
              <span class="text-text-secondary ml-1 text-sm">{{ window.templateName }}</span>
            </span>
          </label>
        </li>
      </ul>
    </div>

    <div>
      <label class="field-label" for="bulk-reason">Reason</label>
      <select
        id="bulk-reason"
        v-model="reasonCodeId"
        class="field"
        :aria-invalid="guard.invalid('bulk-reason')"
        @change="guard.clear()"
      >
        <option value="">Choose a reason…</option>
        <option v-for="code in reasonCodes" :key="code.id" :value="code.id">
          {{ code.label }}
        </option>
      </select>
    </div>

    <div>
      <label class="field-label" for="bulk-note">
        Note{{ selectedCode?.requiresNote ? '' : ' (optional)' }}
      </label>
      <textarea id="bulk-note" v-model="note" class="field min-h-20" />
      <p v-if="reasonProblem" class="text-state-missed mt-1 text-sm">{{ reasonProblem }}</p>
    </div>

    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
        {{ saving ? 'Recording…' : 'Record this reason' }}
      </button>
      <button
        type="button"
        class="btn border-border-default border"
        :disabled="saving"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </div>
  </section>
</template>
