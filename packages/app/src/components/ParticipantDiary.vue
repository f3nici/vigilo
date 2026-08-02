<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  canDeleteDiary,
  canEditOthersDiary,
  canRecordDiary,
  describeVisibility,
  formatByteSize,
  type DiaryCategory,
  type DiaryEntry,
  type DiaryRevision,
} from '@vigilo/shared';
import CategoryChip from '@/components/CategoryChip.vue';
import DiaryEntryForm from '@/components/DiaryEntryForm.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { formatDateTimeIn } from '@/lib/format';

/**
 * The diary tab (doc 06 §4.2).
 *
 * A list of what happened, newest first, with search and a category filter.
 * Search runs on the server over decrypted bodies within this participant's
 * record, which is the only scope an encrypted body can be searched in (A9).
 */
const props = defineProps<{ participantId: string; participantName: string }>();

const session = useSessionStore();
const role = computed(() => session.principal?.role ?? 'worker');

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

function canEdit(entry: DiaryEntry): boolean {
  if (!canWrite.value) return false;
  return entry.recordedBy === session.principal?.userId || canEditOthersDiary(role.value);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list, cats] = await Promise.all([
      api.listDiary(props.participantId, {
        ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
        ...(categoryFilter.value === '' ? {} : { categoryId: categoryFilter.value }),
      }),
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

/** The history says what changed in words, not as two raw column values. */
function describeRevision(revision: DiaryRevision): string {
  const who = revision.changedByName ?? 'Someone';
  const when = formatDateTimeIn(revision.changedAt, timeZone.value);

  switch (revision.field) {
    case 'body':
      return `${who} changed the text on ${when}.`;
    case 'category':
      return `${who} moved it to another category on ${when}.`;
    case 'occurred_at':
      return `${who} changed when it happened to ${formatDateTimeIn(revision.newValue ?? '', timeZone.value)} on ${when}.`;
    case 'visibility':
      return revision.newValue === 'true'
        ? `${who} made it visible to ${props.participantName} on ${when}.`
        : `${who} hid it from ${props.participantName} on ${when}.`;
  }
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

    <FormError :message="error" />

    <DiaryEntryForm
      v-if="composing"
      :participant-id="props.participantId"
      :participant-name="props.participantName"
      :categories="categories"
      :time-zone="timeZone"
      @saved="afterSave"
      @cancelled="composing = false"
    />

    <div class="flex flex-wrap gap-2">
      <div class="min-w-48 flex-1">
        <label class="field-label" for="diary-search">Search this person's diary</label>
        <input
          id="diary-search"
          v-model="search"
          type="search"
          class="field"
          placeholder="seizure, shower, equipment…"
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
        <button type="button" class="btn border-border-default border" @click="load">Search</button>
      </div>
    </div>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <p v-else-if="entries.length === 0" class="card text-text-secondary p-4">
      Nothing recorded{{ search || categoryFilter ? ' that matches' : ' yet' }}.
    </p>

    <ul v-else class="space-y-3">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="card space-y-2 p-4"
        :class="entry.deletedAt ? 'opacity-60' : ''"
      >
        <template v-if="editing?.id === entry.id">
          <DiaryEntryForm
            :participant-id="props.participantId"
            :participant-name="props.participantName"
            :categories="categories"
            :time-zone="timeZone"
            :entry="entry"
            @saved="afterSave"
            @cancelled="editing = null"
          />
        </template>

        <template v-else>
          <div class="flex flex-wrap items-center gap-2">
            <CategoryChip :label="entry.categoryLabel" :colour="entry.categoryColour" />
            <span class="text-text-secondary tabular text-sm">
              {{ formatDateTimeIn(entry.occurredAt, timeZone) }}
            </span>
            <span
              v-if="!entry.visibleToParticipant"
              class="text-text-secondary rounded-full border px-2 py-0.5 text-sm"
              :style="{ borderColor: 'var(--vigilo-not-expected)' }"
            >
              {{ describeVisibility(false, props.participantName) }}
            </span>
            <!--
              An admin can still read a deleted entry, because the row survives
              for retention. It has to say so: without this the admin who just
              pressed Delete sees the entry sitting there unchanged and has no
              way to tell whether anything happened.
            -->
            <span
              v-if="entry.deletedAt"
              class="text-state-missed rounded-full border px-2 py-0.5 text-sm"
              :style="{ borderColor: 'var(--vigilo-missed)' }"
            >
              Deleted {{ formatDateTimeIn(entry.deletedAt, timeZone) }}
            </span>
          </div>

          <p class="whitespace-pre-wrap">{{ entry.body }}</p>

          <ul v-if="entry.attachments.length > 0" class="flex flex-wrap gap-2">
            <li v-for="attachment in entry.attachments" :key="attachment.id">
              <a
                :href="api.attachmentUrl(attachment.id)"
                class="border-border-default flex items-center gap-2 rounded-lg border p-2"
              >
                <img
                  v-if="attachment.isImage"
                  :src="api.thumbnailUrl(attachment.id)"
                  :alt="attachment.filename"
                  class="h-16 w-16 rounded object-cover"
                />
                <span class="text-sm">
                  {{ attachment.filename }}
                  <span class="text-text-secondary block">
                    {{ formatByteSize(attachment.byteSize) }}
                  </span>
                </span>
              </a>
            </li>
          </ul>

          <p class="text-text-secondary text-sm">
            Recorded by {{ entry.recordedByName ?? 'someone' }},
            {{ formatDateTimeIn(entry.recordedAt, timeZone)
            }}<span v-if="entry.editCount > 0">
              · edited {{ entry.editCount }} {{ entry.editCount === 1 ? 'time' : 'times' }}</span
            >.
          </p>

          <div v-if="!entry.deletedAt" class="flex flex-wrap gap-3 text-sm">
            <button
              v-if="canEdit(entry)"
              type="button"
              class="text-primary min-h-11 underline"
              @click="
                editing = entry;
                composing = false;
              "
            >
              Edit
            </button>
            <button
              v-if="entry.editCount > 0"
              type="button"
              class="text-primary min-h-11 underline"
              @click="showHistory(entry.id)"
            >
              Show edit history
            </button>
            <button
              v-if="canDeleteDiary(role) && confirmingDelete !== entry.id"
              type="button"
              class="text-state-missed min-h-11 underline"
              @click="confirmingDelete = entry.id"
            >
              Delete
            </button>
            <template v-else-if="canDeleteDiary(role)">
              <button
                type="button"
                class="text-state-missed min-h-11 underline"
                @click="remove(entry.id)"
              >
                Yes, delete it
              </button>
              <button
                type="button"
                class="text-text-secondary min-h-11 underline"
                @click="confirmingDelete = ''"
              >
                Cancel
              </button>
            </template>
          </div>

          <p v-if="confirmingDelete === entry.id" class="text-text-secondary text-sm">
            The entry stops appearing. Nothing is removed from the record, and the deletion is
            audited.
          </p>

          <ul v-if="revisions[entry.id]?.length" class="text-text-secondary space-y-1 text-sm">
            <li v-for="revision in revisions[entry.id]" :key="revision.id">
              {{ describeRevision(revision)
              }}<span v-if="revision.reason"> Reason: "{{ revision.reason }}".</span>
            </li>
          </ul>
        </template>
      </li>
    </ul>
  </section>
</template>
