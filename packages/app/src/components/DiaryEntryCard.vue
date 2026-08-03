<script setup lang="ts">
import {
  describeVisibility,
  formatByteSize,
  type DiaryEntry,
  type DiaryRevision,
} from '@vigilo/shared';
import CategoryChip from '@/components/CategoryChip.vue';
import * as api from '@/api/client';
import { formatDateTimeIn, formatTimeIn } from '@/lib/format';

/**
 * One diary entry as it reads on screen.
 *
 * Split out of the diary tab so the calendar's day list and the search results
 * show the same thing. Two copies of this markup would have drifted the first
 * time one of them gained a field.
 *
 * Display and the buttons, no loading and no writes: the tab owns the entries,
 * so there is still one place that knows what is on screen and one place that
 * reports an error.
 */
const props = defineProps<{
  entry: DiaryEntry;
  timeZone: string;
  participantName: string;
  canEdit: boolean;
  canDelete: boolean;
  /** Loaded on demand by the tab. Absent means the history has not been asked for. */
  revisions?: DiaryRevision[] | undefined;
  confirmingDelete: boolean;
  /**
   * The day is already the heading in the calendar, so only the time is worth
   * repeating there. The search results are a list across many days and need
   * the date on every row.
   */
  timeOnly?: boolean;
}>();

defineEmits<{
  edit: [];
  showHistory: [];
  requestDelete: [];
  confirmDelete: [];
  cancelDelete: [];
}>();

/** The history says what changed in words, not as two raw column values. */
function describeRevision(revision: DiaryRevision): string {
  const who = revision.changedByName ?? 'Someone';
  const when = formatDateTimeIn(revision.changedAt, props.timeZone);

  switch (revision.field) {
    case 'body':
      return `${who} changed the text on ${when}.`;
    case 'category':
      return `${who} moved it to another category on ${when}.`;
    case 'occurred_at':
      return `${who} changed the day it is on to ${formatDateTimeIn(revision.newValue ?? '', props.timeZone)} on ${when}.`;
    case 'visibility':
      return revision.newValue === 'true'
        ? `${who} made it visible to ${props.participantName} on ${when}.`
        : `${who} hid it from ${props.participantName} on ${when}.`;
  }
}
</script>

<template>
  <div class="space-y-2" :class="entry.deletedAt ? 'opacity-60' : ''">
    <div class="flex flex-wrap items-center gap-2">
      <CategoryChip :label="entry.categoryLabel" :colour="entry.categoryColour" />
      <span class="text-text-secondary tabular text-sm">
        {{
          props.timeOnly
            ? formatTimeIn(entry.occurredAt, timeZone)
            : formatDateTimeIn(entry.occurredAt, timeZone)
        }}
      </span>
      <span
        v-if="!entry.visibleToParticipant"
        class="text-text-secondary rounded-full border px-2 py-0.5 text-sm"
        :style="{ borderColor: 'var(--vigilo-not-expected)' }"
      >
        {{ describeVisibility(false, props.participantName) }}
      </span>
      <!--
        An admin can still read a deleted entry, because the row survives for
        retention. It has to say so: without this the admin who just pressed
        Delete sees the entry sitting there unchanged and has no way to tell
        whether anything happened.
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
      Written by {{ entry.recordedByName ?? 'someone' }},
      {{ formatDateTimeIn(entry.recordedAt, timeZone)
      }}<span v-if="entry.editCount > 0">
        · edited {{ entry.editCount }} {{ entry.editCount === 1 ? 'time' : 'times' }}</span
      >.
    </p>

    <div v-if="!entry.deletedAt" class="flex flex-wrap gap-3 text-sm">
      <button
        v-if="canEdit"
        type="button"
        class="text-primary min-h-11 underline"
        @click="$emit('edit')"
      >
        Edit
      </button>
      <button
        v-if="entry.editCount > 0"
        type="button"
        class="text-primary min-h-11 underline"
        @click="$emit('showHistory')"
      >
        Show edit history
      </button>
      <button
        v-if="canDelete && !confirmingDelete"
        type="button"
        class="text-state-missed min-h-11 underline"
        @click="$emit('requestDelete')"
      >
        Delete
      </button>
      <template v-else-if="canDelete">
        <button
          type="button"
          class="text-state-missed min-h-11 underline"
          @click="$emit('confirmDelete')"
        >
          Yes, delete it
        </button>
        <button
          type="button"
          class="text-text-secondary min-h-11 underline"
          @click="$emit('cancelDelete')"
        >
          Cancel
        </button>
      </template>
    </div>

    <p v-if="confirmingDelete" class="text-text-secondary text-sm">
      The entry stops appearing. Nothing is removed from the record, and the deletion is audited.
    </p>

    <ul v-if="revisions?.length" class="text-text-secondary space-y-1 text-sm">
      <li v-for="revision in revisions" :key="revision.id">
        {{ describeRevision(revision)
        }}<span v-if="revision.reason"> Reason: "{{ revision.reason }}".</span>
      </li>
    </ul>
  </div>
</template>
