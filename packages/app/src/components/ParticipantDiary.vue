<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  addDays,
  canDeleteDiary,
  canEditOthersDiary,
  canRecordDiary,
  localDateOf,
  monthGridRange,
  startOfMonth,
  utcToZoned,
  type DiaryCategory,
  type DiaryEntry,
  type DiaryRevision,
} from '@vigilo/shared';
import DiaryCalendar from '@/components/DiaryCalendar.vue';
import DiaryEntryCard from '@/components/DiaryEntryCard.vue';
import DiaryEntryForm from '@/components/DiaryEntryForm.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { formatDateHeading } from '@/lib/format';

/**
 * The diary tab (doc 06 §4.2).
 *
 * A day book, the way the paper one worked: staff write down what a
 * participant has coming up, and opening it shows what is on today. That is
 * why it opens on a month grid rather than on a reverse-chronological list.
 * Notes about how something went live in the team's notes app, not here.
 *
 * Search is still here as its own view, because "when was the last dental
 * appointment" is a question about the whole record rather than about a day.
 * It runs on the server over decrypted bodies within this participant's record,
 * which is the only scope an encrypted body can be searched in (A9).
 */
const props = defineProps<{ participantId: string; participantName: string }>();

const session = useSessionStore();
const role = computed(() => session.principal?.role ?? 'worker');

const view = ref<'calendar' | 'search'>('calendar');

const entries = ref<DiaryEntry[]>([]);
const categories = ref<DiaryCategory[]>([]);
const search = ref('');
const categoryFilter = ref('');
const timeZone = ref(session.timeZone);
const loading = ref(true);
const error = ref('');

const composing = ref(false);
const editing = ref<DiaryEntry | null>(null);
const confirmingDelete = ref('');

const revisions = ref<Record<string, DiaryRevision[]>>({});

const canWrite = computed(() => canRecordDiary(role.value));

/** Today in the org timezone. A worker on a phone still in another zone gets the org's day. */
const today = computed(() => localDateOf(new Date(), timeZone.value));

const selectedDay = ref(localDateOf(new Date(), session.timeZone));
const month = ref(startOfMonth(selectedDay.value));

function canEdit(entry: DiaryEntry): boolean {
  if (!canWrite.value) return false;
  return entry.recordedBy === session.principal?.userId || canEditOthersDiary(role.value);
}

/**
 * The calendar fetches the grid it draws, not the month it is named after, so
 * the days borrowed from either side still show their markers. Search fetches
 * across everything and leaves the range off.
 */
const query = computed(() => {
  if (view.value === 'search') {
    return {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(categoryFilter.value === '' ? {} : { categoryId: categoryFilter.value }),
      limit: 50,
    };
  }
  const range = monthGridRange(month.value);
  return { from: range.from, to: range.to, limit: 200 };
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list, cats] = await Promise.all([
      api.listDiary(props.participantId, query.value),
      api.listDiaryCategories(),
    ]);
    entries.value = list.entries;
    timeZone.value = list.timeZone;
    categories.value = cats;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the diary.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// Paging the calendar is a different fetch. Typing in the search box is not,
// until the search is submitted.
watch(month, load);
watch(view, load);

/** What is on for the chosen day, earliest first, the way a day is read. */
const dayEntries = computed(() =>
  entries.value
    .filter(
      (entry) => utcToZoned(new Date(entry.occurredAt), timeZone.value).date === selectedDay.value,
    )
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
);

function stepDay(days: number): void {
  selectedDay.value = addDays(selectedDay.value, days);
  // Walking off the end of the grid is what turns the page.
  const range = monthGridRange(month.value);
  if (selectedDay.value < range.from || selectedDay.value > range.to) {
    month.value = startOfMonth(selectedDay.value);
  }
}

function goToToday(): void {
  selectedDay.value = today.value;
  month.value = startOfMonth(today.value);
}

/** A new entry defaults to the day being looked at, which is usually the point of opening it. */
const composeDefault = computed(() => selectedDay.value);

async function afterSave(): Promise<void> {
  composing.value = false;
  editing.value = null;
  await load();
}

async function remove(entryId: string): Promise<void> {
  error.value = '';
  try {
    await api.deleteDiaryEntry(entryId);
    confirmingDelete.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not delete that entry.';
  }
}

async function showHistory(entryId: string): Promise<void> {
  error.value = '';
  try {
    revisions.value = { ...revisions.value, [entryId]: await api.listDiaryRevisions(entryId) };
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the history.';
  }
}

function startEditing(entry: DiaryEntry): void {
  editing.value = entry;
  composing.value = false;
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Diary</h2>
      <button
        v-if="canWrite && !composing"
        type="button"
        class="btn btn-primary ml-auto min-h-11 px-3 text-sm"
        @click="
          composing = true;
          editing = null;
        "
      >
        Add diary entry
      </button>
    </div>

    <!-- Two ways of asking: a day, or the whole record. -->
    <div class="flex flex-wrap gap-2" role="group" aria-label="How to look at the diary">
      <button
        type="button"
        class="btn border-border-default min-h-11 border px-3 text-sm"
        :class="view === 'calendar' ? 'bg-primary-subtle text-primary' : ''"
        :aria-pressed="view === 'calendar'"
        @click="view = 'calendar'"
      >
        Calendar
      </button>
      <button
        type="button"
        class="btn border-border-default min-h-11 border px-3 text-sm"
        :class="view === 'search' ? 'bg-primary-subtle text-primary' : ''"
        :aria-pressed="view === 'search'"
        @click="view = 'search'"
      >
        Search
      </button>
    </div>

    <FormError :message="error" />

    <DiaryEntryForm
      v-if="composing"
      :participant-id="props.participantId"
      :participant-name="props.participantName"
      :categories="categories"
      :time-zone="timeZone"
      :default-day="composeDefault"
      @saved="afterSave"
      @cancelled="composing = false"
    />

    <!-- ------------------------------------------------------- the calendar -->
    <template v-if="view === 'calendar'">
      <DiaryCalendar
        v-model:month="month"
        v-model:selected="selectedDay"
        :today="today"
        :entries="entries"
        :time-zone="timeZone"
      />

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn border-border-default min-h-11 border px-3 text-sm"
          @click="stepDay(-1)"
        >
          ← Day before
        </button>
        <h3 class="flex-1 text-center font-semibold">
          {{ formatDateHeading(selectedDay) }}
          <span v-if="selectedDay === today" class="text-text-secondary font-normal">(today)</span>
        </h3>
        <button
          type="button"
          class="btn border-border-default min-h-11 border px-3 text-sm"
          @click="stepDay(1)"
        >
          Day after →
        </button>
      </div>

      <div v-if="selectedDay !== today" class="flex">
        <button
          type="button"
          class="text-primary mx-auto min-h-11 text-sm underline"
          @click="goToToday"
        >
          Back to today
        </button>
      </div>

      <p v-if="loading" class="text-text-secondary">Loading.</p>

      <p v-else-if="dayEntries.length === 0" class="card text-text-secondary p-4">
        Nothing on this day.
      </p>

      <ul v-else class="space-y-3">
        <li v-for="entry in dayEntries" :key="entry.id" class="card p-4">
          <DiaryEntryForm
            v-if="editing?.id === entry.id"
            :participant-id="props.participantId"
            :participant-name="props.participantName"
            :categories="categories"
            :time-zone="timeZone"
            :entry="entry"
            @saved="afterSave"
            @cancelled="editing = null"
          />
          <DiaryEntryCard
            v-else
            :entry="entry"
            :time-zone="timeZone"
            :participant-name="props.participantName"
            :can-edit="canEdit(entry)"
            :can-delete="canDeleteDiary(role)"
            :revisions="revisions[entry.id]"
            :confirming-delete="confirmingDelete === entry.id"
            time-only
            @edit="startEditing(entry)"
            @show-history="showHistory(entry.id)"
            @request-delete="confirmingDelete = entry.id"
            @confirm-delete="remove(entry.id)"
            @cancel-delete="confirmingDelete = ''"
          />
        </li>
      </ul>
    </template>

    <!-- --------------------------------------------------------- the search -->
    <template v-else>
      <div class="flex flex-wrap gap-2">
        <div class="min-w-48 flex-1">
          <label class="field-label" for="diary-search">Search this person's diary</label>
          <input
            id="diary-search"
            v-model="search"
            type="search"
            class="field"
            placeholder="dentist, hydro, review meeting…"
            @keyup.enter="load"
          />
        </div>
        <div class="min-w-40">
          <label class="field-label" for="diary-category-filter">Category</label>
          <select id="diary-category-filter" v-model="categoryFilter" class="field" @change="load">
            <option value="">All categories</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.label }}
            </option>
          </select>
        </div>
        <div class="flex items-end">
          <button type="button" class="btn border-border-default border" @click="load">
            Search
          </button>
        </div>
      </div>

      <p v-if="loading" class="text-text-secondary">Loading.</p>

      <p v-else-if="entries.length === 0" class="card text-text-secondary p-4">
        Nothing recorded{{ search || categoryFilter ? ' that matches' : ' yet' }}.
      </p>

      <ul v-else class="space-y-3">
        <li v-for="entry in entries" :key="entry.id" class="card p-4">
          <DiaryEntryForm
            v-if="editing?.id === entry.id"
            :participant-id="props.participantId"
            :participant-name="props.participantName"
            :categories="categories"
            :time-zone="timeZone"
            :entry="entry"
            @saved="afterSave"
            @cancelled="editing = null"
          />
          <DiaryEntryCard
            v-else
            :entry="entry"
            :time-zone="timeZone"
            :participant-name="props.participantName"
            :can-edit="canEdit(entry)"
            :can-delete="canDeleteDiary(role)"
            :revisions="revisions[entry.id]"
            :confirming-delete="confirmingDelete === entry.id"
            @edit="startEditing(entry)"
            @show-history="showHistory(entry.id)"
            @request-delete="confirmingDelete = entry.id"
            @confirm-delete="remove(entry.id)"
            @cancel-delete="confirmingDelete = ''"
          />
        </li>
      </ul>
    </template>
  </section>
</template>
