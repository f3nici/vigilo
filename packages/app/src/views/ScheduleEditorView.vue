<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  describeSegment,
  describeWeekdays,
  formatWindowRange,
  localDateOf,
  type CheckSchedule,
  type CheckTemplate,
  type SchedulePreview,
  type SegmentInput,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * The schedule editor (doc 06 §5).
 *
 * The rule this screen exists for: **the preview is not optional and updates
 * live.** An admin sets a window length and an anchor and immediately sees the
 * actual clock times, overlaid with coverage, rather than inferring them from
 * two numbers.
 *
 * Overlapping segments are a hard error. Gaps, uneven division and a
 * misaligned anchor are warnings, because each can be exactly what was meant.
 */
const route = useRoute();

const participantId = computed(() => route.params.id as string);

const templates = ref<CheckTemplate[]>([]);
const schedules = ref<CheckSchedule[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);
const notice = ref('');

/** The schedule being edited, or null when building a new one. */
const editingId = ref<string | null>(null);
const templateId = ref('');
const name = ref('');
const activeFrom = ref(localDateOf(new Date(), 'Australia/Melbourne'));
const segments = ref<SegmentInput[]>([]);

const preview = ref<SchedulePreview | null>(null);
const previewDate = ref(localDateOf(new Date(), 'Australia/Melbourne'));

const publishedTemplates = computed(() =>
  templates.value.filter((template) => template.publishedVersion !== null),
);

/** A simple case stays simple: segments only appear once there is a second. */
const showSegmentDetail = computed(() => segments.value.length > 1);

function blankSegment(): SegmentInput {
  return {
    windowMinutes: 120,
    anchorTime: '07:00',
    appliesFromTime: '00:00',
    // Midnight as 00:00, not 24:00: <input type="time"> rejects 24:00 and
    // renders an empty box. The two mean the same span.
    appliesToTime: '00:00',
    weekdays: null,
    sortOrder: segments.value.length,
    label: null,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    [templates.value, schedules.value] = await Promise.all([
      api.listTemplates(),
      api.listSchedules(participantId.value),
    ]);
    if (segments.value.length === 0) segments.value = [blankSegment()];
    if (templateId.value === '' && publishedTemplates.value.length > 0) {
      templateId.value = publishedTemplates.value[0]!.id;
    }
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the schedules.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

let previewTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  [segments, previewDate],
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), 250);
  },
  { deep: true, immediate: false },
);

async function refreshPreview(): Promise<void> {
  if (segments.value.length === 0) return;
  try {
    preview.value = await api.previewSchedule(
      participantId.value,
      { date: previewDate.value, segments: segments.value },
      editingId.value ?? undefined,
    );
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not work out the windows.';
  }
}

onMounted(refreshPreview);

function addSegment(): void {
  segments.value.push({
    ...blankSegment(),
    appliesFromTime: '21:00',
    appliesToTime: '07:00',
    anchorTime: '21:00',
  });
}

function removeSegment(index: number): void {
  segments.value.splice(index, 1);
}

function edit(schedule: CheckSchedule): void {
  editingId.value = schedule.id;
  templateId.value = schedule.templateId;
  name.value = schedule.name;
  activeFrom.value = schedule.activeFrom;
  segments.value = schedule.segments.map((segment) => ({
    windowMinutes: segment.windowMinutes,
    anchorTime: segment.anchorTime,
    appliesFromTime: segment.appliesFromTime,
    appliesToTime: segment.appliesToTime,
    weekdays: segment.weekdays,
    sortOrder: segment.sortOrder,
    label: segment.label,
  }));
  void refreshPreview();
}

function startNew(): void {
  editingId.value = null;
  name.value = '';
  segments.value = [blankSegment()];
  preview.value = null;
  void refreshPreview();
}

const blocked = computed(() => (preview.value?.problems.length ?? 0) > 0);

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (editingId.value === null) {
      await api.createSchedule(participantId.value, {
        templateId: templateId.value,
        name: name.value,
        activeFrom: activeFrom.value,
        segments: segments.value,
      });
      notice.value = 'Schedule created, and the windows for the next week are laid out.';
    } else {
      const result = await api.putSegments(editingId.value, segments.value);
      notice.value = `Saved. ${result.regenerated.created} future windows regenerated, ${result.regenerated.removed} replaced, ${result.regenerated.preserved} left alone because they already hold a check or are open now.`;
    }
    schedules.value = await api.listSchedules(participantId.value);
    if (editingId.value === null) startNew();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the schedule.';
  } finally {
    saving.value = false;
  }
}

async function end(schedule: CheckSchedule): Promise<void> {
  if (!confirm(`End "${schedule.name}"? Past windows and recorded checks are kept.`)) return;
  try {
    await api.endSchedule(schedule.id);
    schedules.value = await api.listSchedules(participantId.value);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not end the schedule.';
  }
}

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function toggleWeekday(segment: SegmentInput, weekday: number): void {
  const current = segment.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  const next = current.includes(weekday)
    ? current.filter((one) => one !== weekday)
    : [...current, weekday];
  segment.weekdays = next.length === 7 ? null : next.length === 0 ? [weekday] : next;
}

function appliesOn(segment: SegmentInput, weekday: number): boolean {
  return segment.weekdays === null || segment.weekdays.includes(weekday);
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <RouterLink :to="{ name: 'participant', params: { id: participantId } }" class="text-primary">
        ← Participant
      </RouterLink>
      <h1 class="text-2xl font-semibold">Check schedule</h1>
    </div>

    <FormError :message="error" />
    <p v-if="notice" class="text-text-secondary">{{ notice }}</p>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <section v-if="schedules.length > 0" class="card p-4">
        <h2 class="text-lg font-semibold">Current schedules</h2>
        <ul class="mt-3 space-y-2">
          <li
            v-for="schedule in schedules"
            :key="schedule.id"
            class="border-border-default flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <div>
              <p class="font-medium">{{ schedule.name }}</p>
              <p class="text-text-secondary text-sm">
                {{ schedule.templateName }} ·
                {{ schedule.segments.length }}
                {{ schedule.segments.length === 1 ? 'segment' : 'segments' }} · from
                {{ schedule.activeFrom }}
              </p>
            </div>
            <div class="ml-auto flex gap-2">
              <button
                type="button"
                class="btn border-border-default border"
                @click="edit(schedule)"
              >
                Edit
              </button>
              <button type="button" class="btn border-border-default border" @click="end(schedule)">
                End
              </button>
            </div>
          </li>
        </ul>
      </section>

      <div class="grid gap-5 lg:grid-cols-2">
        <section class="card space-y-4 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold">
              {{ editingId === null ? 'New schedule' : 'Edit segments' }}
            </h2>
            <button
              v-if="editingId !== null"
              type="button"
              class="btn border-border-default ml-auto border"
              @click="startNew"
            >
              Start a new one
            </button>
          </div>

          <template v-if="editingId === null">
            <div>
              <label class="field-label" for="schedule-template">Check form</label>
              <select id="schedule-template" v-model="templateId" class="field">
                <option
                  v-for="template in publishedTemplates"
                  :key="template.id"
                  :value="template.id"
                >
                  {{ template.name }} (v{{ template.publishedVersion?.version }})
                </option>
              </select>
              <p v-if="publishedTemplates.length === 0" class="text-state-missed mt-1 text-sm">
                No check form has been published yet. Publish one first.
              </p>
            </div>

            <div>
              <label class="field-label" for="schedule-name">Name</label>
              <input
                id="schedule-name"
                v-model="name"
                class="field"
                type="text"
                placeholder="Vent observations"
              />
            </div>

            <div>
              <label class="field-label" for="schedule-from">Active from</label>
              <input id="schedule-from" v-model="activeFrom" class="field max-w-48" type="date" />
            </div>
          </template>

          <div>
            <div class="flex items-center gap-2">
              <span class="field-label mb-0">{{ showSegmentDetail ? 'Segments' : 'Timing' }}</span>
              <button
                type="button"
                class="btn border-border-default ml-auto border"
                @click="addSegment"
              >
                Add a segment
              </button>
            </div>

            <ul class="mt-3 space-y-3">
              <li
                v-for="(segment, index) in segments"
                :key="index"
                class="border-border-default space-y-3 rounded-lg border p-3"
              >
                <div v-if="showSegmentDetail" class="flex items-center gap-2">
                  <input
                    v-model="segment.label"
                    class="field flex-1"
                    type="text"
                    placeholder="Daytime"
                    :aria-label="`Segment ${index + 1} name`"
                  />
                  <button
                    type="button"
                    class="text-state-missed min-h-11 px-2"
                    aria-label="Remove segment"
                    @click="removeSegment(index)"
                  >
                    ✕
                  </button>
                </div>

                <div class="flex flex-wrap gap-3">
                  <div>
                    <label class="field-label" :for="`window-${index}`">Every</label>
                    <select
                      :id="`window-${index}`"
                      v-model.number="segment.windowMinutes"
                      class="field max-w-40"
                    >
                      <option :value="30">30 minutes</option>
                      <option :value="60">1 hour</option>
                      <option :value="120">2 hours</option>
                      <option :value="180">3 hours</option>
                      <option :value="240">4 hours</option>
                      <option :value="360">6 hours</option>
                      <option :value="720">12 hours</option>
                      <option :value="1440">24 hours</option>
                    </select>
                  </div>
                  <div>
                    <label class="field-label" :for="`anchor-${index}`">Starting from</label>
                    <input
                      :id="`anchor-${index}`"
                      v-model="segment.anchorTime"
                      class="field max-w-32"
                      type="time"
                    />
                  </div>
                  <div>
                    <label class="field-label" :for="`from-${index}`">Between</label>
                    <input
                      :id="`from-${index}`"
                      v-model="segment.appliesFromTime"
                      class="field max-w-32"
                      type="time"
                    />
                  </div>
                  <div>
                    <label class="field-label" :for="`to-${index}`">and</label>
                    <input
                      :id="`to-${index}`"
                      v-model="segment.appliesToTime"
                      class="field max-w-32"
                      type="time"
                    />
                  </div>
                </div>

                <div>
                  <span class="field-label">On</span>
                  <div class="flex flex-wrap gap-1">
                    <button
                      v-for="day in WEEKDAYS"
                      :key="day.value"
                      type="button"
                      class="border-border-default min-h-11 rounded-lg border px-3"
                      :class="appliesOn(segment, day.value) ? 'bg-primary-subtle text-primary' : ''"
                      :aria-pressed="appliesOn(segment, day.value)"
                      @click="toggleWeekday(segment, day.value)"
                    >
                      {{ day.label }}
                    </button>
                  </div>
                  <p class="text-text-secondary mt-1 text-sm">
                    {{ describeSegment(segment) }} · {{ describeWeekdays(segment.weekdays) }}
                  </p>
                </div>
              </li>
            </ul>
          </div>

          <button
            type="button"
            class="btn btn-primary"
            :disabled="
              saving || blocked || (editingId === null && (name.trim() === '' || templateId === ''))
            "
            @click="save"
          >
            {{ saving ? 'Saving…' : editingId === null ? 'Create schedule' : 'Save segments' }}
          </button>
        </section>

        <!-- The preview. Not optional, and it updates as the form is typed. -->
        <section class="card space-y-3 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold">Preview</h2>
            <input
              v-model="previewDate"
              class="field ml-auto max-w-44"
              type="date"
              aria-label="Preview date"
            />
          </div>

          <ul
            v-if="preview && preview.problems.length > 0"
            class="text-state-missed space-y-1 text-sm"
          >
            <li v-for="(problem, index) in preview.problems" :key="index">{{ problem.message }}</li>
          </ul>

          <template v-if="preview && preview.problems.length === 0">
            <p class="text-text-secondary text-sm">
              {{ preview.windows.length }} windows on this day, in {{ preview.timeZone }}.
            </p>

            <ul class="flex flex-wrap gap-2">
              <li
                v-for="window in preview.windows"
                :key="window.startsAt"
                class="border-border-default tabular rounded-lg border px-3 py-2 text-sm"
                :class="window.expected ? '' : 'opacity-60'"
                :title="window.coverageReason ?? 'Supported hours'"
              >
                {{ formatWindowRange(window) }}
                <span v-if="!window.expected" class="text-text-secondary block text-xs">
                  {{ window.coverageReason }}
                </span>
              </li>
            </ul>

            <ul v-if="preview.warnings.length > 0" class="space-y-1 text-sm">
              <li
                v-for="(warning, index) in preview.warnings"
                :key="index"
                :style="{ color: 'var(--vigilo-partial)' }"
              >
                {{ warning.message }}
              </li>
            </ul>

            <p v-if="editingId !== null" class="text-text-secondary text-sm">
              Saving regenerates {{ preview.windowsToRegenerate }} windows that have not closed yet.
              Past windows are never touched.
            </p>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>
