<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  choicesOf,
  orderedFields,
  validateFieldValue,
  type CheckValue,
  type TemplateSchema,
} from '@vigilo/shared';
import RichText from '@/components/RichText.vue';

/**
 * Renders a check form from a template version schema (doc 06 §4.3).
 *
 * One renderer, used by the worker recording a check and by the admin's live
 * preview in the field builder. The admin sees exactly what a worker will,
 * because it is the same component, not a mock-up that drifts.
 *
 * **No value is ever coloured, flagged or annotated.** There is no code here
 * that could, and there is nothing in the schema to drive it if there were
 * (D14). Colour in this app signals record state, never a reading.
 */
const props = defineProps<{
  schema: TemplateSchema;
  values: Record<string, CheckValue>;
  /** The preview in the builder is inert: it shows the form, it takes nothing. */
  readonly?: boolean;
}>();

const emit = defineEmits<{ change: [value: CheckValue] }>();

const fields = computed(() => orderedFields(props.schema));

function valueOf(key: string): CheckValue {
  return props.values[key] ?? { fieldKey: key };
}

function problemFor(key: string): string | null {
  const field = fields.value.find((one) => one.key === key);
  if (!field) return null;
  return validateFieldValue(field, valueOf(key));
}

function setNumber(key: string, raw: string): void {
  emit('change', { fieldKey: key, number: raw.trim() === '' ? null : Number(raw) });
}

function setBool(key: string, value: boolean | null): void {
  emit('change', { fieldKey: key, bool: value });
}

function setText(key: string, raw: string): void {
  emit('change', { fieldKey: key, text: raw === '' ? null : raw });
}

function setJson(key: string, value: string | string[] | null): void {
  emit('change', { fieldKey: key, json: value });
}

function toggleInList(key: string, option: string): void {
  const current = valueOf(key).json;
  const list = Array.isArray(current) ? current : [];
  const next = list.includes(option) ? list.filter((one) => one !== option) : [...list, option];
  setJson(key, next.length === 0 ? null : next);
}

function isChecked(key: string, option: string): boolean {
  const current = valueOf(key).json;
  return Array.isArray(current) && current.includes(option);
}

function asString(key: string): string {
  const current = valueOf(key).json;
  return typeof current === 'string' ? current : '';
}

function numberText(key: string): string {
  const current = valueOf(key).number;
  return current === null || current === undefined ? '' : String(current);
}

/* ------------------------------------------------------- several times */

/**
 * The time being typed, before it joins the list.
 *
 * A worker adds one time at a time, and until they press the button it is not
 * part of the record. Committing on every keystroke of an `<input type="time">`
 * would write 1 o'clock on the way to typing 13:45.
 */
const pendingTime = ref<Record<string, string>>({});

function timeList(key: string): string[] {
  const current = valueOf(key).json;
  return Array.isArray(current) ? current : [];
}

/**
 * Times are kept in clock order rather than the order they were typed. A worker
 * who remembers the earlier neb second should not produce a record that reads
 * 15:30 then 14:10, and the order they were entered in is not a fact about the
 * day.
 */
function addTime(key: string): void {
  const time = pendingTime.value[key] ?? '';
  if (time === '') return;
  const list = timeList(key);
  if (!list.includes(time)) setJson(key, [...list, time].sort());
  pendingTime.value[key] = '';
}

function removeTime(key: string, index: number): void {
  const next = timeList(key).filter((_, position) => position !== index);
  setJson(key, next.length === 0 ? null : next);
}
</script>

<template>
  <div class="space-y-6">
    <p v-if="fields.length === 0" class="text-text-secondary">
      No fields yet. Add one and it appears here exactly as a worker will see it.
    </p>

    <template v-for="field in fields" :key="field.key">
      <!--
        Guidance, not a field. It takes no answer, so it is not a fieldset and
        has no label, no asterisk and no validation line: it reads as the
        reference material it is, sitting where the decision gets made.
      -->
      <section v-if="field.type === 'info'" class="border-border-default rounded-lg border p-4">
        <h3 class="mb-2 font-semibold">{{ field.label }}</h3>
        <RichText :source="field.body" />
      </section>

      <fieldset v-else class="space-y-2" :disabled="readonly">
        <legend class="field-label">
          {{ field.label }}
          <span v-if="field.required" class="text-state-missed" aria-label="required">*</span>
        </legend>

        <!--
        Number: a numeric keypad, with the unit beside it where there is one.
        Plenty of these are counters and have none (doc 06 §4.3).
      -->
        <div v-if="field.type === 'number'" class="flex items-center gap-2">
          <input
            :id="`field-${field.key}`"
            class="field tabular max-w-48"
            type="text"
            inputmode="decimal"
            :value="numberText(field.key)"
            :aria-label="field.label"
            @input="setNumber(field.key, ($event.target as HTMLInputElement).value)"
          />
          <span v-if="field.unit" class="text-text-secondary">{{ field.unit }}</span>
        </div>

        <div v-else-if="field.type === 'boolean'" class="flex gap-2">
          <button
            type="button"
            class="btn border-border-default border"
            :class="valueOf(field.key).bool === true ? 'bg-primary-subtle text-primary' : ''"
            :aria-pressed="valueOf(field.key).bool === true"
            @click="setBool(field.key, valueOf(field.key).bool === true ? null : true)"
          >
            Yes
          </button>
          <button
            type="button"
            class="btn border-border-default border"
            :class="valueOf(field.key).bool === false ? 'bg-primary-subtle text-primary' : ''"
            :aria-pressed="valueOf(field.key).bool === false"
            @click="setBool(field.key, valueOf(field.key).bool === false ? null : false)"
          >
            No
          </button>
        </div>

        <div v-else-if="field.type === 'single_choice'" class="flex flex-wrap gap-2">
          <label
            v-for="option in choicesOf(field)"
            :key="option.value"
            class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
            :class="asString(field.key) === option.value ? 'bg-primary-subtle text-primary' : ''"
          >
            <input
              type="radio"
              class="size-5"
              :name="`field-${field.key}`"
              :value="option.value"
              :checked="asString(field.key) === option.value"
              @change="setJson(field.key, option.value)"
            />
            {{ option.label }}
          </label>
        </div>

        <div
          v-else-if="field.type === 'checklist' || field.type === 'multi_choice'"
          class="flex flex-wrap gap-2"
        >
          <label
            v-for="option in choicesOf(field)"
            :key="option.value"
            class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
            :class="isChecked(field.key, option.value) ? 'bg-primary-subtle text-primary' : ''"
          >
            <input
              type="checkbox"
              class="size-5"
              :checked="isChecked(field.key, option.value)"
              @change="toggleInList(field.key, option.value)"
            />
            {{ option.label }}
          </label>
        </div>

        <!--
          Several times, for something that can happen more than once inside one
          window. The times already added are shown as they will be recorded, so
          a worker can see the second neb landed at 15:30 before they save.
        -->
        <div v-else-if="field.type === 'time' && field.allowMultiple" class="space-y-2">
          <ul v-if="timeList(field.key).length > 0" class="flex flex-wrap gap-2">
            <li
              v-for="(time, index) in timeList(field.key)"
              :key="time"
              class="border-border-default flex min-h-11 items-center gap-1 rounded-lg border px-3"
            >
              <span class="tabular">{{ time }}</span>
              <button
                type="button"
                class="text-state-missed min-h-11 px-1"
                :aria-label="`Remove ${time}`"
                @click="removeTime(field.key, index)"
              >
                &#10005;
              </button>
            </li>
          </ul>

          <div class="flex flex-wrap items-center gap-2">
            <input
              :id="`field-${field.key}`"
              v-model="pendingTime[field.key]"
              class="field max-w-40"
              type="time"
              :aria-label="`${field.label}, a time to add`"
            />
            <button
              type="button"
              class="btn border-border-default border"
              @click="addTime(field.key)"
            >
              Add this time
            </button>
          </div>

          <p v-if="timeList(field.key).length === 0" class="text-text-secondary text-sm">
            Add each one as it happens.
          </p>
        </div>

        <textarea
          v-else-if="field.type === 'text' && field.multiline"
          :id="`field-${field.key}`"
          class="field min-h-28"
          :maxlength="field.maxLength"
          :value="valueOf(field.key).text ?? ''"
          :aria-label="field.label"
          @input="setText(field.key, ($event.target as HTMLTextAreaElement).value)"
        />

        <input
          v-else-if="field.type === 'text'"
          :id="`field-${field.key}`"
          class="field"
          type="text"
          :maxlength="field.maxLength"
          :value="valueOf(field.key).text ?? ''"
          :aria-label="field.label"
          @input="setText(field.key, ($event.target as HTMLInputElement).value)"
        />

        <input
          v-else
          :id="`field-${field.key}`"
          class="field max-w-64"
          :type="field.type === 'datetime' ? 'datetime-local' : field.type"
          :value="asString(field.key)"
          :aria-label="field.label"
          @input="setJson(field.key, ($event.target as HTMLInputElement).value || null)"
        />

        <p v-if="field.help" class="text-text-secondary text-sm">{{ field.help }}</p>
        <p v-if="problemFor(field.key)" class="text-state-missed text-sm">
          {{ problemFor(field.key) }}
        </p>
      </fieldset>
    </template>
  </div>
</template>
