<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import {
  fieldTypes,
  suggestFieldKey,
  templateFieldSchema,
  validateTemplateSchema,
  type CheckTemplate,
  type CheckValue,
  type Choice,
  type FieldType,
  type PublishPreview,
  type TemplateField,
  type TemplateSchema,
} from '@vigilo/shared';
import DynamicForm from '@/components/DynamicForm.vue';
import FieldTypeGuide from '@/components/FieldTypeGuide.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * The field builder (doc 06 §5).
 *
 * Left: the ordered field list. Right: the real rendered form, updating live,
 * built by the same component a worker uses. This is where an admin decides
 * what "checks every 2 hours" actually means, so it shows the answer rather
 * than describing it.
 *
 * There is no range, threshold or alerting control anywhere on this screen and
 * there is nowhere in the schema to put one (D14).
 */
const route = useRoute();
const router = useRouter();

const template = ref<CheckTemplate | null>(null);
const versionId = ref<string | null>(null);
const fields = ref<TemplateField[]>([]);
const selected = ref<number | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const savedAt = ref('');
const preview = ref<PublishPreview | null>(null);
const publishing = ref(false);

/** Only before the first publish. After that a key is locked forever. */
const keysEditable = computed(() => template.value?.publishedVersion === null);

const schema = computed<TemplateSchema>(() => ({ fields: fields.value }));
const problems = computed(() => validateTemplateSchema(schema.value));
const current = computed(() => (selected.value === null ? null : fields.value[selected.value]));

/** The preview needs no answers: it is showing the form, not filling it. */
const emptyValues = computed<Record<string, CheckValue>>(() => ({}));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const id = route.params.id as string;
    template.value = await api.getTemplate(id);

    // Reading a published form opens a draft to edit, because there is nothing
    // else you can usefully do on this screen.
    const draft = template.value.draftVersion ?? (await api.startDraft(id));
    versionId.value = draft.id;
    fields.value = [...draft.schema.fields];
    if (fields.value.length > 0) selected.value = 0;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open that check form.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Autosaves the draft. A draft is scratch space, so it saves as you type. */
watch(
  fields,
  () => {
    if (loading.value || versionId.value === null) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 600);
  },
  { deep: true },
);

async function save(): Promise<void> {
  if (versionId.value === null) return;
  saving.value = true;
  error.value = '';
  try {
    await api.saveDraftSchema(versionId.value, schema.value);
    savedAt.value = new Date().toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    preview.value = null;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the draft.';
  } finally {
    saving.value = false;
  }
}

function nextSort(): number {
  return fields.value.reduce((max, field) => Math.max(max, field.sort), 0) + 10;
}

function addField(type: FieldType): void {
  const label = 'New field';
  let key = suggestFieldKey(label);
  let suffix = 2;
  while (fields.value.some((field) => field.key === key)) {
    key = `${suggestFieldKey(label)}_${suffix}`;
    suffix += 1;
  }

  const base = { key, label, required: false, sort: nextSort() };
  const created = templateFieldSchema.parse(
    type === 'number'
      ? // No unit by default. Plenty of these are counts, and a unit that was
        // guessed for you is a unit that ends up in the record unread.
        { ...base, type, unit: null, decimals: 0 }
      : type === 'text'
        ? { ...base, type, multiline: false, maxLength: 2000 }
        : type === 'checklist'
          ? { ...base, type, items: [{ value: 'item_1', label: 'First item' }] }
          : type === 'single_choice' || type === 'multi_choice'
            ? { ...base, type, options: [{ value: 'option_1', label: 'First option' }] }
            : type === 'info'
              ? { ...base, type, label: 'Guidance', body: 'Write the guidance here.' }
              : { ...base, type },
  );

  fields.value.push(created);
  selected.value = fields.value.length - 1;
}

function removeField(index: number): void {
  fields.value.splice(index, 1);
  selected.value = fields.value.length === 0 ? null : Math.min(index, fields.value.length - 1);
}

/** Reordering rewrites `sort`, which is what the renderer actually reads. */
function move(index: number, by: number): void {
  const target = index + by;
  if (target < 0 || target >= fields.value.length) return;
  const [moved] = fields.value.splice(index, 1);
  fields.value.splice(target, 0, moved!);
  fields.value.forEach((field, position) => {
    field.sort = (position + 1) * 10;
  });
  selected.value = target;
}

function relabel(value: string): void {
  const field = current.value;
  if (!field) return;
  field.label = value;
  if (keysEditable.value) field.key = suggestFieldKey(value);
}

function choicesFor(field: TemplateField): Choice[] {
  if (field.type === 'checklist') return field.items;
  if (field.type === 'single_choice' || field.type === 'multi_choice') return field.options;
  return [];
}

function addChoice(): void {
  const field = current.value;
  if (!field) return;
  const list = choicesFor(field);
  const value = `option_${list.length + 1}`;
  list.push({ value, label: `Option ${list.length + 1}` });
}

function removeChoice(index: number): void {
  const field = current.value;
  if (!field) return;
  choicesFor(field).splice(index, 1);
}

function relabelChoice(index: number, label: string): void {
  const field = current.value;
  if (!field) return;
  const choice = choicesFor(field)[index];
  if (!choice) return;
  choice.label = label;
  // Option values are only ever generated, never typed, so they stay stable
  // identifiers rather than becoming whatever a label happened to say.
  if (keysEditable.value) choice.value = suggestFieldKey(label) || choice.value;
}

/**
 * Publishing is one button now.
 *
 * It used to need "Review changes" clicked first, which left the publish button
 * greyed out with nothing on screen explaining why. The review still happens,
 * it just happens where it is useful: after you have asked to publish, as the
 * thing you are confirming.
 */
const confirming = ref(false);

async function askToPublish(): Promise<void> {
  if (versionId.value === null) return;
  error.value = '';
  clearTimeout(saveTimer);
  await save();

  if (problems.value.length > 0) {
    error.value = 'Fix the problems listed below before publishing.';
    return;
  }

  try {
    preview.value = await api.getPublishPreview(versionId.value);
    confirming.value = true;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not work out the changes.';
  }
}

async function publish(): Promise<void> {
  if (versionId.value === null) return;
  publishing.value = true;
  error.value = '';
  try {
    await api.publishVersion(versionId.value);
    await router.push({ name: 'check-templates' });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not publish.';
    confirming.value = false;
  } finally {
    publishing.value = false;
  }
}

const typeLabels: Record<FieldType, string> = {
  number: 'Number',
  boolean: 'Yes or no',
  checklist: 'Checklist',
  single_choice: 'One of',
  multi_choice: 'Several of',
  text: 'Text',
  date: 'Date',
  time: 'Time',
  datetime: 'Date and time',
  info: 'Information',
};
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <RouterLink :to="{ name: 'check-templates' }" class="text-primary">← Check forms</RouterLink>
      <h1 class="text-2xl font-semibold">{{ template?.name ?? 'Check form' }}</h1>
      <span v-if="saving" class="text-text-secondary text-sm">Saving…</span>
      <span v-else-if="savedAt" class="text-text-secondary text-sm">Draft saved {{ savedAt }}</span>
    </div>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else class="grid gap-5 lg:grid-cols-2">
      <!-- Left: the field list and the editor for whichever is selected. -->
      <section class="space-y-4">
        <div class="card p-4">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold">Fields</h2>
            <FieldTypeGuide />
            <select
              class="field ml-auto max-w-44"
              aria-label="Add a field"
              @change="
                addField(($event.target as HTMLSelectElement).value as FieldType);
                ($event.target as HTMLSelectElement).value = '';
              "
            >
              <option value="">Add a field…</option>
              <option v-for="type in fieldTypes" :key="type" :value="type">
                {{ typeLabels[type] }}
              </option>
            </select>
          </div>

          <ul class="mt-3 space-y-2">
            <li
              v-for="(field, index) in fields"
              :key="field.key"
              class="border-border-default flex items-center gap-2 rounded-lg border p-2"
              :class="selected === index ? 'bg-primary-subtle' : ''"
            >
              <button type="button" class="min-h-11 flex-1 text-left" @click="selected = index">
                <span class="font-medium">{{ field.label }}</span>
                <span class="text-text-secondary ml-2 text-sm">{{ typeLabels[field.type] }}</span>
                <span v-if="field.required" class="text-text-secondary ml-1 text-sm"
                  >· required</span
                >
              </button>
              <button
                type="button"
                class="min-h-11 px-2"
                aria-label="Move up"
                :disabled="index === 0"
                @click="move(index, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="min-h-11 px-2"
                aria-label="Move down"
                :disabled="index === fields.length - 1"
                @click="move(index, 1)"
              >
                ↓
              </button>
              <button
                type="button"
                class="text-state-missed min-h-11 px-2"
                aria-label="Remove field"
                @click="removeField(index)"
              >
                ✕
              </button>
            </li>
          </ul>

          <p v-if="fields.length === 0" class="text-text-secondary mt-2">
            No fields yet. Add the first one.
          </p>
        </div>

        <div v-if="current" class="card space-y-3 p-4">
          <h2 class="text-lg font-semibold">Edit field</h2>

          <div>
            <label class="field-label" for="field-label">Label</label>
            <input
              id="field-label"
              class="field"
              type="text"
              :value="current.label"
              @input="relabel(($event.target as HTMLInputElement).value)"
            />
          </div>

          <div>
            <label class="field-label" for="field-key">Key</label>
            <input
              id="field-key"
              v-model="current.key"
              class="field"
              type="text"
              :disabled="!keysEditable"
            />
            <p class="text-text-secondary mt-1 text-sm">
              {{
                keysEditable
                  ? 'Generated from the label. Editable until this form is first published, then locked forever.'
                  : 'Locked. Records already point at this key, so changing it would be a new field.'
              }}
            </p>
          </div>

          <!--
            Guidance. The body is source text and is rendered by the same code
            that renders a care plan, so what is typed here reads the same on a
            phone with no signal.
          -->
          <div v-if="current.type === 'info'">
            <label class="field-label" for="field-body">Guidance</label>
            <textarea id="field-body" v-model="current.body" class="field min-h-40" />
            <p class="text-text-secondary mt-1 text-sm">
              Takes ## headings, - bullets, **bold** and tables. A table is a row of headings, a row
              of dashes under it, then the rows, each one written | like | this |. It records
              nothing and never appears in a report.
            </p>
          </div>

          <div v-if="current.type === 'number'" class="flex flex-wrap gap-3">
            <div>
              <label class="field-label" for="field-unit">Unit</label>
              <input
                id="field-unit"
                class="field max-w-32"
                type="text"
                placeholder="None"
                :value="current.unit ?? ''"
                @input="current.unit = ($event.target as HTMLInputElement).value.trim() || null"
              />
              <p class="text-text-secondary mt-1 text-sm">Leave it blank for a plain count.</p>
            </div>
            <div>
              <label class="field-label" for="field-decimals">Decimal places</label>
              <input
                id="field-decimals"
                v-model.number="current.decimals"
                class="field max-w-32"
                type="number"
                min="0"
                max="4"
              />
            </div>
            <div>
              <label class="field-label" for="field-min">Lowest accepted</label>
              <input
                id="field-min"
                v-model.number="current.min"
                class="field max-w-32"
                type="number"
              />
            </div>
            <div>
              <label class="field-label" for="field-max">Highest accepted</label>
              <input
                id="field-max"
                v-model.number="current.max"
                class="field max-w-32"
                type="number"
              />
            </div>
            <p class="text-text-secondary text-sm">
              These stop a slipped decimal point reaching the record. They are not a normal range,
              and nothing is ever flagged for being outside them.
            </p>
          </div>

          <div
            v-if="
              choicesFor(current).length > 0 ||
              ['checklist', 'single_choice', 'multi_choice'].includes(current.type)
            "
          >
            <span class="field-label">Options</span>
            <ul class="space-y-2">
              <li
                v-for="(choice, index) in choicesFor(current)"
                :key="index"
                class="flex items-center gap-2"
              >
                <input
                  class="field flex-1"
                  type="text"
                  :value="choice.label"
                  :aria-label="`Option ${index + 1}`"
                  @input="relabelChoice(index, ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="text-state-missed min-h-11 px-2"
                  aria-label="Remove option"
                  @click="removeChoice(index)"
                >
                  ✕
                </button>
              </li>
            </ul>
            <button type="button" class="btn border-border-default mt-2 border" @click="addChoice">
              Add an option
            </button>
          </div>

          <template v-if="current.type === 'text'">
            <div>
              <span class="field-label">How much room</span>
              <div class="flex flex-wrap gap-2">
                <label
                  class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
                  :class="current.multiline ? '' : 'bg-primary-subtle text-primary'"
                >
                  <input
                    type="radio"
                    class="size-5"
                    :checked="!current.multiline"
                    @change="current.multiline = false"
                  />
                  One line
                </label>
                <label
                  class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
                  :class="current.multiline ? 'bg-primary-subtle text-primary' : ''"
                >
                  <input
                    type="radio"
                    class="size-5"
                    :checked="current.multiline"
                    @change="current.multiline = true"
                  />
                  Several lines
                </label>
              </div>
              <p class="text-text-secondary mt-1 text-sm">
                One line for a few words. Several only when you are asking for a paragraph.
              </p>
            </div>

            <div>
              <label class="field-label" for="field-maxlength">Maximum length</label>
              <input
                id="field-maxlength"
                v-model.number="current.maxLength"
                class="field max-w-32"
                type="number"
                min="1"
              />
            </div>
          </template>

          <div v-if="current.type === 'time'">
            <label class="flex min-h-11 items-center gap-2">
              <input v-model="current.allowMultiple" type="checkbox" class="size-5" />
              Allow several times
            </label>
            <p class="text-text-secondary mt-1 text-sm">
              For something that can happen more than once inside one check, like a nebuliser given
              twice in two hours. The worker adds each time as it happens.
            </p>
          </div>

          <template v-if="current.type !== 'info'">
            <div>
              <label class="field-label" for="field-help">Help text</label>
              <input id="field-help" v-model="current.help" class="field" type="text" />
            </div>

            <label class="flex min-h-11 items-center gap-2">
              <input v-model="current.required" type="checkbox" class="size-5" />
              Required to complete the check
            </label>
          </template>
        </div>
      </section>

      <!-- Right: the real form, exactly as a worker sees it on a phone. -->
      <section class="space-y-4">
        <div class="card p-4">
          <h2 class="text-lg font-semibold">Live preview</h2>
          <p class="text-text-secondary mt-1 text-sm">
            Exactly what a worker sees on their phone. No value is ever coloured or flagged.
          </p>
          <div class="mt-4">
            <DynamicForm :schema="schema" :values="emptyValues" readonly />
          </div>
        </div>

        <div class="card space-y-3 p-4">
          <h2 class="text-lg font-semibold">Publish</h2>

          <p class="text-text-secondary text-sm">
            Publishing makes this version the one workers fill in. It becomes version
            {{ (template?.publishedVersion?.version ?? 0) + 1 }} and cannot be edited afterwards.
            Editing it later starts the next version instead, and every record already entered stays
            on the version it was recorded against, so nothing that has been written breaks.
          </p>

          <ul v-if="problems.length > 0" class="text-state-missed space-y-1 text-sm">
            <li v-for="(problem, index) in problems" :key="index">
              {{ problem.field ? `${problem.field}: ` : '' }}{{ problem.message }}
            </li>
          </ul>

          <button type="button" class="btn btn-primary" @click="askToPublish">
            Publish this version
          </button>
        </div>
      </section>
    </div>

    <!--
      The confirm. It carries the diff, which is what an admin actually needs at
      the moment they are deciding, rather than a step they had to complete
      before the button would work.
    -->
    <div
      v-if="confirming && preview"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      @click.self="confirming = false"
    >
      <div
        class="card my-8 w-full max-w-lg space-y-3 p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Publish this version"
      >
        <h2 class="text-lg font-semibold">Publish {{ template?.name }}?</h2>

        <div>
          <p class="font-medium">What changes</p>
          <ul class="text-text-secondary mt-1 space-y-1 text-sm">
            <li v-for="key in preview.diff.added" :key="`a-${key}`">Added {{ key }}</li>
            <li v-for="key in preview.diff.removed" :key="`r-${key}`">Removed {{ key }}</li>
            <li v-for="change in preview.diff.relabelled" :key="`l-${change.key}`">
              Renamed {{ change.key }} from "{{ change.from }}" to "{{ change.to }}"
            </li>
            <li v-for="change in preview.diff.changed" :key="`c-${change.key}-${change.what}`">
              {{ change.key }}: {{ change.what }}
            </li>
            <li
              v-if="
                preview.diff.added.length === 0 &&
                preview.diff.removed.length === 0 &&
                preview.diff.relabelled.length === 0 &&
                preview.diff.changed.length === 0
              "
            >
              Nothing has changed since the published version.
            </li>
          </ul>
        </div>

        <ul v-if="preview.problems.length > 0" class="text-state-missed space-y-1 text-sm">
          <li v-for="(problem, index) in preview.problems" :key="index">
            {{ problem.field ? `${problem.field}: ` : '' }}{{ problem.message }}
          </li>
        </ul>

        <p class="text-text-secondary text-sm">
          This cannot be undone. Records already entered keep the version they were recorded against
          and are not touched.
        </p>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="publishing || preview.problems.length > 0"
            @click="publish"
          >
            {{ publishing ? 'Publishing…' : 'Yes, publish it' }}
          </button>
          <button
            type="button"
            class="btn border-border-default border"
            @click="confirming = false"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
