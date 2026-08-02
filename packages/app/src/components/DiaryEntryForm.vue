<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  DIARY_BODY_MAX,
  describeVisibility,
  formatByteSize,
  formatTimeOfDay,
  occurredAtProblem,
  parseTimeOfDay,
  utcToZoned,
  zonedTimeToUtc,
  type AttachmentSummary,
  type DiaryCategory,
  type DiaryEntry,
} from '@vigilo/shared';
import CategoryChip from '@/components/CategoryChip.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { FilePrepareError, prepareForUpload } from '@/lib/images';
import { needs, needsChoice, needsText, useFormGuard } from '@/lib/forms';

/**
 * Writing a diary entry (doc 06 §4.5).
 *
 * Category chips, the body, when it happened, photos, and the visibility
 * toggle. The toggle is written in plain language with the participant's name
 * in it, because "visible_to_participant" is a column name and "Alice can see
 * this entry" is a decision someone can actually make.
 */
const props = defineProps<{
  participantId: string;
  participantName: string;
  categories: DiaryCategory[];
  /** The organisation's timezone, the only one staff ever see (doc 06 §7). */
  timeZone: string;
  /** Set when editing. Absent means a new entry. */
  entry?: DiaryEntry | null;
}>();

const emit = defineEmits<{ saved: []; cancelled: [] }>();

const categoryId = ref('');
const body = ref('');
const occurredAtLocal = ref('');
const visible = ref(true);
const reason = ref('');

const attachments = ref<AttachmentSummary[]>([]);
const uploading = ref(false);
const saving = ref(false);
const error = ref('');

const isEdit = computed(() => props.entry !== null && props.entry !== undefined);

/**
 * `<input type="datetime-local">` speaks wall clock, not ISO, and it has no
 * idea which zone that wall clock belongs to.
 *
 * Both directions therefore go through the org timezone rather than the
 * device's. A phone set to another zone, or a worker who has travelled, must
 * type the hour the shift actually happened at, and see it back unchanged.
 */
function toInput(iso: string): string {
  const zoned = utcToZoned(new Date(iso), props.timeZone);
  return `${zoned.date}T${formatTimeOfDay(zoned.minutes)}`;
}

function fromInput(value: string): Date | null {
  const [date, time] = value.split('T');
  if (!date || !time) return null;
  try {
    return zonedTimeToUtc(date, parseTimeOfDay(time.slice(0, 5)), props.timeZone);
  } catch {
    return null;
  }
}

function reset(): void {
  const entry = props.entry;
  categoryId.value = entry?.categoryId ?? props.categories[0]?.id ?? '';
  body.value = entry?.body ?? '';
  occurredAtLocal.value = toInput(entry?.occurredAt ?? new Date().toISOString());
  visible.value = entry?.visibleToParticipant ?? true;
  attachments.value = entry ? [...entry.attachments] : [];
  reason.value = '';
  error.value = '';
}

watch(() => props.entry, reset, { immediate: true });
watch(() => props.categories, reset);

const occurredAt = computed(() => fromInput(occurredAtLocal.value));

const timeProblem = computed(() => {
  const at = occurredAt.value;
  if (at === null || Number.isNaN(at.getTime())) return 'Say when this happened.';
  return occurredAtProblem(at, new Date());
});

/**
 * What still has to be answered, in the order the fields appear. The button is
 * never greyed out for any of it: pressing it says which one and points there.
 */
const guard = useFormGuard();

const checks = () => [
  needsChoice('diary-category', categoryId.value, 'Choose what this entry is about.'),
  needsText('diary-body', body.value, 'Write what happened before saving.'),
  needs(
    'diary-body',
    body.value.length <= DIARY_BODY_MAX,
    `This entry is longer than the ${DIARY_BODY_MAX} characters an entry can hold.`,
  ),
  needs('diary-occurred-at', timeProblem.value === null, timeProblem.value ?? ''),
];

async function attach(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;

  uploading.value = true;
  error.value = '';

  try {
    for (const file of files) {
      // Resized and re-encoded here, then stripped again on the server. The
      // second pass is the one that counts; this one is about the upload size
      // and about HEIC never reaching the server at all.
      const prepared = await prepareForUpload(file);
      const created = await api.createAttachment(props.participantId, {
        id: crypto.randomUUID(),
        ownerType: 'diary_entry',
        ownerId: props.entry?.id ?? null,
        filename: prepared.filename,
        mimeType: prepared.mimeType,
        byteSize: prepared.blob.size,
      });
      const uploaded = await api.uploadAttachmentContent(created.id, prepared.blob);
      attachments.value = [...attachments.value, uploaded];
    }
  } catch (err) {
    error.value =
      err instanceof FilePrepareError || err instanceof ApiRequestError
        ? err.message
        : 'That file could not be attached.';
  } finally {
    uploading.value = false;
  }
}

async function removeAttachment(id: string): Promise<void> {
  error.value = '';
  try {
    await api.deleteAttachment(id);
    attachments.value = attachments.value.filter((one) => one.id !== id);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not remove that file.';
  }
}

async function save(): Promise<void> {
  if (saving.value || uploading.value || !guard.ready(...checks())) return;
  saving.value = true;
  error.value = '';

  try {
    if (props.entry) {
      await api.updateDiaryEntry(props.entry.id, {
        categoryId: categoryId.value,
        body: body.value,
        occurredAt: occurredAt.value!.toISOString(),
        visibleToParticipant: visible.value,
        ...(reason.value.trim() === '' ? {} : { reason: reason.value.trim() }),
      });
    } else {
      await api.createDiaryEntry(props.participantId, {
        // A device-generated UUID v7 would come from the outbox in Phase 5.
        id: crypto.randomUUID(),
        categoryId: categoryId.value,
        body: body.value,
        occurredAt: occurredAt.value!.toISOString(),
        visibleToParticipant: visible.value,
        attachmentIds: attachments.value.map((one) => one.id),
      });
    }
    emit('saved');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that entry.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="card space-y-4 p-4" @submit.prevent="save">
    <h3 class="text-lg font-semibold">{{ isEdit ? 'Edit entry' : 'New diary entry' }}</h3>

    <FormError :message="error" />

    <!--
      Each chip carries its own aria-label. Leaving the name to be computed
      from the chip's text worked only for the selected one: the unselected
      chips render an aria-hidden dot beside the label and came out as unnamed
      buttons, so seven of the eight categories announced nothing at all.
    -->
    <fieldset>
      <legend class="field-label">Category</legend>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="category in props.categories"
          :key="category.id"
          type="button"
          class="min-h-11"
          :aria-pressed="categoryId === category.id"
          :aria-label="category.label"
          @click="categoryId = category.id"
        >
          <CategoryChip
            :label="category.label"
            :colour="category.colour"
            :selected="categoryId === category.id"
          />
        </button>
      </div>
    </fieldset>

    <div>
      <label class="field-label" for="diary-body">What happened</label>
      <textarea
        id="diary-body"
        v-model="body"
        class="field min-h-32"
        :maxlength="DIARY_BODY_MAX"
        placeholder="Assisted with shower, good mood throughout."
      />
      <p class="text-text-secondary mt-1 text-sm">
        Dictation works from the keyboard if typing is awkward.
      </p>
    </div>

    <div>
      <label class="field-label" for="diary-occurred">When it happened</label>
      <input id="diary-occurred" v-model="occurredAtLocal" type="datetime-local" class="field" />
      <p v-if="timeProblem" class="text-state-missed mt-1 text-sm">{{ timeProblem }}</p>
      <p v-else class="text-text-secondary mt-1 text-sm">
        Defaults to now. Change it if you are writing up something from earlier.
      </p>
    </div>

    <!-- Doc 06 §4.5: the label names the person, not the column. -->
    <div class="flex items-start gap-3">
      <input id="diary-visible" v-model="visible" type="checkbox" class="mt-1 h-5 w-5" />
      <label for="diary-visible">
        {{ describeVisibility(true, props.participantName) }}
        <span v-if="!visible" class="text-text-secondary block text-sm">
          {{ describeVisibility(false, props.participantName) }}. Staff can still read it.
        </span>
      </label>
    </div>

    <div>
      <span class="field-label">Photos and files</span>
      <ul v-if="attachments.length > 0" class="mb-2 space-y-2">
        <li
          v-for="attachment in attachments"
          :key="attachment.id"
          class="border-border-default flex items-center gap-3 rounded-lg border p-2"
        >
          <img
            v-if="attachment.isImage"
            :src="api.thumbnailUrl(attachment.id)"
            :alt="attachment.filename"
            class="h-12 w-12 rounded object-cover"
          />
          <span class="min-w-0 flex-1 truncate">
            {{ attachment.filename }}
            <span class="text-text-secondary">{{ formatByteSize(attachment.byteSize) }}</span>
          </span>
          <button
            type="button"
            class="text-state-missed min-h-11 px-2 text-sm underline"
            @click="removeAttachment(attachment.id)"
          >
            Remove
          </button>
        </li>
      </ul>

      <input
        id="diary-files"
        type="file"
        accept="image/*,application/pdf"
        multiple
        class="field"
        :disabled="uploading"
        @change="attach"
      />
      <p class="text-text-secondary mt-1 text-sm">
        <span v-if="uploading">Uploading…</span>
        <span v-else>Photos are resized before they are sent, and location tags are removed.</span>
      </p>
    </div>

    <div v-if="isEdit">
      <label class="field-label" for="diary-reason">Why you are changing it (optional)</label>
      <input id="diary-reason" v-model="reason" type="text" class="field" maxlength="300" />
    </div>

    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn btn-primary" :disabled="saving || uploading">
        {{ saving ? 'Saving…' : isEdit ? 'Save changes' : 'Record entry' }}
      </button>
      <button type="button" class="btn border-border-default border" @click="emit('cancelled')">
        Cancel
      </button>
    </div>
  </form>
</template>
