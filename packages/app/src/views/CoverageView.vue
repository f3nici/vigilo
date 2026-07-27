<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  addDays,
  localDateOf,
  type CoverageException,
  type RecalculationPreview,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDateTime } from '@/lib/format';

/**
 * Coverage (doc 06 §5).
 *
 * The supported hours, and the dated overrides for when reality differed.
 * A window outside coverage is not counted as missed, so this screen decides
 * what the compliance report means.
 *
 * Recalculating is previewed first and never applied silently, because it can
 * rewrite months of compliance history in one click.
 */
const route = useRoute();
const participantId = computed(() => route.params.id as string);

type Range = { weekday: number; startTime: string; endTime: string };

const ranges = ref<Range[]>([]);
const exceptions = ref<CoverageException[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');

const preview = ref<RecalculationPreview | null>(null);
const from = ref(localDateOf(new Date(), 'Australia/Melbourne'));
const to = ref(addDays(localDateOf(new Date(), 'Australia/Melbourne'), 7));

const exceptionStart = ref('');
const exceptionEnd = ref('');
const exceptionEffect = ref<'covered' | 'not_covered'>('not_covered');
const exceptionReason = ref('');

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

function rangesFor(weekday: number): Range[] {
  return ranges.value.filter((range) => range.weekday === weekday);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [pattern, list] = await Promise.all([
      api.getCoveragePattern(participantId.value),
      api.listCoverageExceptions(participantId.value),
    ]);
    ranges.value = pattern.ranges.map((range) => ({ ...range }));
    exceptions.value = list;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load coverage.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function addRange(weekday: number): void {
  ranges.value.push({ weekday, startTime: '07:00', endTime: '19:00' });
}

function removeRange(range: Range): void {
  ranges.value.splice(ranges.value.indexOf(range), 1);
}

async function savePattern(): Promise<void> {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const pattern = await api.putCoveragePattern(participantId.value, ranges.value);
    ranges.value = pattern.ranges.map((range) => ({ ...range }));
    notice.value =
      'Saved. This applies from today. Windows already created keep their current setting until you recalculate below.';
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the pattern.';
  } finally {
    saving.value = false;
  }
}

async function addException(): Promise<void> {
  error.value = '';
  try {
    const created = await api.createCoverageException(participantId.value, {
      startsAt: new Date(exceptionStart.value).toISOString(),
      endsAt: new Date(exceptionEnd.value).toISOString(),
      effect: exceptionEffect.value,
      reason: exceptionReason.value,
    });
    exceptions.value = [...exceptions.value, created];
    exceptionStart.value = '';
    exceptionEnd.value = '';
    exceptionReason.value = '';
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not add the exception.';
  }
}

async function removeException(exception: CoverageException): Promise<void> {
  try {
    await api.deleteCoverageException(exception.id);
    exceptions.value = exceptions.value.filter((one) => one.id !== exception.id);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not remove it.';
  }
}

async function recalculate(apply: boolean): Promise<void> {
  error.value = '';
  notice.value = '';
  try {
    preview.value = await api.recalculateCoverage(participantId.value, {
      from: from.value,
      to: to.value,
      apply,
    });
    if (apply) {
      notice.value = 'Applied and recorded in the audit log.';
      preview.value = null;
    }
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not recalculate.';
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <RouterLink :to="{ name: 'participant', params: { id: participantId } }" class="text-primary">
        ← Participant
      </RouterLink>
      <h1 class="text-2xl font-semibold">Coverage</h1>
    </div>

    <p class="text-text-secondary">
      The hours the support team is there. A check window outside these hours is not expected and is
      never counted as missed, so family-supported time does not show as a failure.
    </p>

    <FormError :message="error" />
    <p v-if="notice" class="text-text-secondary">{{ notice }}</p>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <section class="card p-4">
        <h2 class="text-lg font-semibold">Weekly pattern</h2>
        <p class="text-text-secondary mt-1 text-sm">
          Leave a day empty for no coverage. A range that runs past midnight is two ranges, one
          ending 24:00 and one starting 00:00 the next day. With no ranges at all, every window is
          expected.
        </p>

        <ul class="mt-4 space-y-3">
          <li v-for="day in WEEKDAYS" :key="day.value" class="flex flex-wrap items-center gap-2">
            <span class="w-28 font-medium">{{ day.label }}</span>

            <div
              v-for="range in rangesFor(day.value)"
              :key="`${range.weekday}-${range.startTime}-${range.endTime}`"
              class="flex items-center gap-1"
            >
              <input
                v-model="range.startTime"
                class="field max-w-32"
                type="time"
                aria-label="From"
              />
              <span class="text-text-secondary">to</span>
              <input v-model="range.endTime" class="field max-w-32" type="time" aria-label="To" />
              <button
                type="button"
                class="text-state-missed min-h-11 px-2"
                aria-label="Remove range"
                @click="removeRange(range)"
              >
                ✕
              </button>
            </div>

            <span v-if="rangesFor(day.value).length === 0" class="text-text-secondary text-sm">
              Not covered
            </span>

            <button
              type="button"
              class="btn border-border-default border"
              @click="addRange(day.value)"
            >
              Add hours
            </button>
          </li>
        </ul>

        <button type="button" class="btn btn-primary mt-4" :disabled="saving" @click="savePattern">
          {{ saving ? 'Saving…' : 'Save pattern' }}
        </button>
      </section>

      <section class="card p-4">
        <h2 class="text-lg font-semibold">Exceptions</h2>
        <p class="text-text-secondary mt-1 text-sm">
          Dated overrides for when reality differed: a family holiday, a hospital admission, a
          one-off extra shift. These win over the weekly pattern.
        </p>

        <form class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="addException">
          <div>
            <label class="field-label" for="exception-start">From</label>
            <input
              id="exception-start"
              v-model="exceptionStart"
              class="field"
              type="datetime-local"
              required
            />
          </div>
          <div>
            <label class="field-label" for="exception-end">To</label>
            <input
              id="exception-end"
              v-model="exceptionEnd"
              class="field"
              type="datetime-local"
              required
            />
          </div>
          <div>
            <label class="field-label" for="exception-effect">Effect</label>
            <select id="exception-effect" v-model="exceptionEffect" class="field max-w-48">
              <option value="not_covered">Nobody from the team</option>
              <option value="covered">Team is there</option>
            </select>
          </div>
          <div class="min-w-48 flex-1">
            <label class="field-label" for="exception-reason">Reason</label>
            <input
              id="exception-reason"
              v-model="exceptionReason"
              class="field"
              type="text"
              required
              placeholder="Family holiday"
            />
          </div>
          <button class="btn border-border-default border" type="submit">Add</button>
        </form>

        <ul v-if="exceptions.length > 0" class="mt-4 space-y-2">
          <li
            v-for="exception in exceptions"
            :key="exception.id"
            class="border-border-default flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <span class="tabular text-sm">
              {{ formatDateTime(exception.startsAt) }} to {{ formatDateTime(exception.endsAt) }}
            </span>
            <span
              class="rounded-full border px-2 py-0.5 text-sm"
              :style="{
                borderColor:
                  exception.effect === 'covered'
                    ? 'var(--vigilo-complete)'
                    : 'var(--vigilo-not-expected)',
                color:
                  exception.effect === 'covered'
                    ? 'var(--vigilo-complete)'
                    : 'var(--vigilo-not-expected)',
              }"
            >
              {{ exception.effect === 'covered' ? 'Team is there' : 'Nobody from the team' }}
            </span>
            <span class="text-text-secondary text-sm">{{ exception.reason }}</span>
            <button
              type="button"
              class="text-state-missed ml-auto min-h-11 px-2"
              @click="removeException(exception)"
            >
              Remove
            </button>
          </li>
        </ul>
      </section>

      <section class="card p-4">
        <h2 class="text-lg font-semibold">Recalculate</h2>
        <p class="text-text-secondary mt-1 text-sm">
          Applies the current coverage to windows that already exist. This can change compliance
          history, so it shows what would move before anything does. Windows already holding a
          recorded check are never touched.
        </p>

        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label class="field-label" for="recalc-from">From</label>
            <input id="recalc-from" v-model="from" class="field max-w-48" type="date" />
          </div>
          <div>
            <label class="field-label" for="recalc-to">To</label>
            <input id="recalc-to" v-model="to" class="field max-w-48" type="date" />
          </div>
          <button
            type="button"
            class="btn border-border-default border"
            @click="recalculate(false)"
          >
            Show what would change
          </button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="preview === null"
            @click="recalculate(true)"
          >
            Apply
          </button>
        </div>

        <div v-if="preview" class="text-text-secondary mt-3 text-sm">
          <p>{{ preview.windowsExamined }} windows examined.</p>
          <p>{{ preview.becomingExpected }} would become expected.</p>
          <p>{{ preview.becomingNotExpected }} would become not expected.</p>
          <p>{{ preview.skippedWithEntries }} left alone because a check is already recorded.</p>
        </div>
      </section>
    </template>
  </div>
</template>
