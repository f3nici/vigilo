<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  canManageTemplates,
  checkFormExportSchema,
  type CheckFormExport,
  type CheckTemplate,
  type ImportedForm,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { formatDateTime } from '@/lib/format';
import { needsText, useFormGuard } from '@/lib/forms';

/**
 * Check forms (doc 06 §5).
 *
 * A form is a template plus its versions. This screen is about the lifecycle:
 * what is published, what is being drafted, and what a schedule is using.
 */
const session = useSessionStore();
const router = useRouter();

const templates = ref<CheckTemplate[]>([]);
const loading = ref(true);
const error = ref('');
const name = ref('');
const description = ref('');
const creating = ref(false);

const canManage = computed(() => canManageTemplates(session.principal?.role ?? 'worker'));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    templates.value = await api.listTemplates();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the check forms.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const guard = useFormGuard();

/* --------------------------------------------------------------- renaming */

/**
 * Renaming a form.
 *
 * The name and the description are the two things about a form that are not
 * versioned, so changing them touches no record: entries point at a version and
 * a version holds the field set. An import that hit a name collision arrives
 * called "something (imported)" (D91), which is the honest thing for it to do
 * and a terrible thing to leave on a form staff will read for years.
 */
const renamingId = ref<string | null>(null);
const renameName = ref('');
const renameDescription = ref('');
const renaming = ref(false);

function startRename(template: CheckTemplate): void {
  guard.clear();
  error.value = '';
  imported.value = [];
  renamingId.value = template.id;
  renameName.value = template.name;
  renameDescription.value = template.description ?? '';
}

function cancelRename(): void {
  renamingId.value = null;
  guard.clear();
}

async function saveRename(): Promise<void> {
  const id = renamingId.value;
  if (id === null || renaming.value) return;
  if (!guard.ready(needsText('rename-name', renameName.value, 'A check form needs a name.'))) {
    return;
  }

  renaming.value = true;
  error.value = '';
  try {
    await api.updateTemplate(id, {
      name: renameName.value,
      description: renameDescription.value.trim() === '' ? null : renameDescription.value,
    });
    renamingId.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not rename the check form.';
  } finally {
    renaming.value = false;
  }
}

/* ------------------------------------------------------- export and import */

const fileInput = ref<HTMLInputElement | null>(null);
const exporting = ref(false);
const importing = ref(false);
const imported = ref<ImportedForm[]>([]);

const busy = computed(() => exporting.value || importing.value);

/** Hands the browser a file without leaving the page. */
function download(document_: CheckFormExport, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Safe in a filename on every platform, and still recognisable six months on. */
function fileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'check-form' : slug;
}

async function exportAll(): Promise<void> {
  if (busy.value) return;
  exporting.value = true;
  error.value = '';
  imported.value = [];
  try {
    const document_ = await api.exportCheckForms();
    download(document_, `vigilo-check-forms-${document_.exportedAt.slice(0, 10)}.json`);
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not export the check forms.';
  } finally {
    exporting.value = false;
  }
}

async function exportOne(template: CheckTemplate): Promise<void> {
  if (busy.value) return;
  exporting.value = true;
  error.value = '';
  imported.value = [];
  try {
    const document_ = await api.exportCheckForms([template.id]);
    download(document_, `vigilo-${fileSlug(template.name)}.json`);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not export that form.';
  } finally {
    exporting.value = false;
  }
}

function chooseFile(): void {
  fileInput.value?.click();
}

/**
 * Reads the file here and posts the parsed document, so a file that is not a
 * Vigilo export is refused on the spot with something readable rather than
 * coming back as a validation error about a field nobody typed.
 */
async function importChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  importing.value = true;
  error.value = '';
  imported.value = [];
  try {
    const parsed = checkFormExportSchema.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      error.value = 'That file is not a Vigilo check form export.';
      return;
    }

    imported.value = await api.importCheckForms(parsed.data);
    await load();
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'That file could not be read as JSON.';
  } finally {
    importing.value = false;
  }
}

async function create(): Promise<void> {
  if (
    !guard.ready(
      needsText('template-name', name.value, 'Give the check form a name before creating it.'),
    )
  ) {
    return;
  }

  creating.value = true;
  error.value = '';
  try {
    const created = await api.createTemplate({
      name: name.value,
      description: description.value.trim() === '' ? null : description.value,
    });
    await router.push({ name: 'check-template', params: { id: created.id } });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not create the check form.';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <h1 class="text-2xl font-semibold">Check forms</h1>
    <p class="text-text-secondary">
      What a worker is asked to record. A form is versioned: publishing a change never touches
      records already entered against an earlier version.
    </p>

    <FormError :message="guard.problem.value?.message ?? error" />

    <!--
      The hint lives under the row rather than under the Name box. Inside the
      flex item it made that column taller than the Description one, and the two
      inputs stopped lining up for the sake of a sentence that describes the
      whole form anyway.
    -->
    <form v-if="canManage" class="card space-y-2 p-4" @submit.prevent="create">
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-56 flex-1">
          <label class="field-label" for="template-name">Name</label>
          <input
            id="template-name"
            v-model="name"
            class="field"
            type="text"
            placeholder="Vent observations"
            :aria-invalid="guard.invalid('template-name')"
            @input="guard.clear()"
          />
        </div>
        <div class="min-w-56 flex-1">
          <label class="field-label" for="template-description">Description</label>
          <input
            id="template-description"
            v-model="description"
            class="field"
            type="text"
            placeholder="2-hourly ventilator checks"
          />
        </div>
        <button class="btn btn-primary" type="submit" :disabled="creating">
          {{ creating ? 'Creating…' : 'New check form' }}
        </button>
      </div>
      <p class="text-text-secondary text-sm">
        What the team calls this set of checks. You add the fields on the next screen.
      </p>
    </form>

    <!--
      Export and import (D91). Building a twenty-field form is an afternoon, and
      doing it again on another box is the same afternoon. A file moves it.
    -->
    <section v-if="canManage" class="card space-y-2 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-semibold">Move forms between installations</h2>
        <div class="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            class="btn border-border-default border"
            :disabled="busy"
            @click="exportAll"
          >
            {{ exporting ? 'Exporting…' : 'Export all forms' }}
          </button>
          <button
            type="button"
            class="btn border-border-default border"
            :disabled="busy"
            @click="chooseFile"
          >
            {{ importing ? 'Importing…' : 'Import from a file' }}
          </button>
        </div>
      </div>

      <p class="text-text-secondary text-sm">
        An export is the names and the fields, and nothing else: no records, no participants, no
        publication history. Everything imported arrives as an unpublished draft for you to check
        and publish here, so nothing lands in front of a worker straight off a file.
      </p>

      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        @change="importChosen"
      />

      <ul v-if="imported.length > 0" class="space-y-1 text-sm">
        <li v-for="form in imported" :key="form.id">
          Imported <span class="font-medium">{{ form.name }}</span>
          <span v-if="form.name !== form.originalName" class="text-text-secondary">
            (a form called "{{ form.originalName }}" was already here, so this one was renamed.
            Rename it to whatever you want on its row below)
          </span>
          <span class="text-text-secondary">
            · {{ form.fieldCount }} {{ form.fieldCount === 1 ? 'field' : 'fields' }}, draft
          </span>
        </li>
      </ul>
    </section>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else-if="templates.length === 0" class="card p-6">
      <p class="font-medium">No check forms yet.</p>
      <p class="text-text-secondary mt-1">
        {{
          canManage
            ? 'Create one, add its fields, then publish it before scheduling it.'
            : 'An admin or a nurse sets these up.'
        }}
      </p>
    </div>

    <ul v-else class="space-y-3">
      <li v-for="template in templates" :key="template.id" class="card p-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div>
            <p class="text-lg font-semibold">{{ template.name }}</p>
            <p v-if="template.description" class="text-text-secondary text-sm">
              {{ template.description }}
            </p>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-2 text-sm">
            <span
              v-if="template.publishedVersion"
              class="rounded-full border px-2 py-0.5"
              :style="{ borderColor: 'var(--vigilo-complete)', color: 'var(--vigilo-complete)' }"
            >
              Published v{{ template.publishedVersion.version }}
            </span>
            <span
              v-else
              class="rounded-full border px-2 py-0.5"
              :style="{
                borderColor: 'var(--vigilo-not-expected)',
                color: 'var(--vigilo-not-expected)',
              }"
            >
              Never published
            </span>
            <span
              v-if="template.draftVersion"
              class="rounded-full border px-2 py-0.5"
              :style="{ borderColor: 'var(--vigilo-partial)', color: 'var(--vigilo-partial)' }"
            >
              Draft v{{ template.draftVersion.version }}
            </span>
            <RouterLink
              v-if="canManage"
              class="btn border-border-default border"
              :to="{ name: 'check-template', params: { id: template.id } }"
            >
              Edit fields
            </RouterLink>
            <button
              v-if="canManage"
              type="button"
              class="btn border-border-default border"
              @click="startRename(template)"
            >
              Rename
            </button>
            <button
              v-if="canManage"
              type="button"
              class="btn border-border-default border"
              :disabled="busy"
              @click="exportOne(template)"
            >
              Export
            </button>
          </div>
        </div>

        <!--
          The name and the description, in place. Neither is versioned, so this
          changes no record: an entry points at a version and a version holds
          the field set. Publishing history is untouched by it.
        -->
        <form
          v-if="renamingId === template.id"
          class="border-border-default mt-3 space-y-2 rounded-lg border p-3"
          @submit.prevent="saveRename"
        >
          <div class="flex flex-wrap items-end gap-3">
            <div class="min-w-56 flex-1">
              <label class="field-label" for="rename-name">Name</label>
              <input
                id="rename-name"
                v-model="renameName"
                class="field"
                type="text"
                :aria-invalid="guard.invalid('rename-name')"
                @input="guard.clear()"
              />
            </div>
            <div class="min-w-56 flex-1">
              <label class="field-label" for="rename-description">Description</label>
              <input
                id="rename-description"
                v-model="renameDescription"
                class="field"
                type="text"
              />
            </div>
            <button class="btn btn-primary" type="submit" :disabled="renaming">
              {{ renaming ? 'Saving…' : 'Save' }}
            </button>
            <button type="button" class="btn border-border-default border" @click="cancelRename">
              Cancel
            </button>
          </div>
          <p class="text-text-secondary text-sm">
            What the team calls this form. Records already entered are not affected, and neither is
            the published version.
          </p>
        </form>

        <p class="text-text-secondary mt-2 text-sm">
          {{ template.scheduleCount }}
          {{ template.scheduleCount === 1 ? 'schedule uses' : 'schedules use' }} this form.
          <span v-if="template.publishedVersion?.publishedAt">
            Published {{ formatDateTime(template.publishedVersion.publishedAt) }}
            <span v-if="template.publishedVersion.publishedByName">
              by {{ template.publishedVersion.publishedByName }}</span
            >.
          </span>
        </p>
      </li>
    </ul>
  </div>
</template>
