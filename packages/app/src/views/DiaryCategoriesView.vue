<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  diaryCategoryColours,
  suggestCategorySlug,
  type DiaryCategory,
  type DiaryCategoryColour,
} from '@vigilo/shared';
import CategoryChip from '@/components/CategoryChip.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { needsText, useFormGuard } from '@/lib/forms';

/**
 * Diary categories (doc 06 §5).
 *
 * This is the organisation's vocabulary, not the developer's, which is why it
 * is configuration rather than an enum. Categories are deactivated rather than
 * deleted, so an entry written last year keeps the category it was filed
 * under and a report of that year still adds up.
 */
const categories = ref<DiaryCategory[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const label = ref('');
const colour = ref<DiaryCategoryColour>('slate');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    categories.value = await api.listDiaryCategories(true);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the categories.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const guard = useFormGuard();

async function add(): Promise<void> {
  if (
    saving.value ||
    !guard.ready(needsText('category-label', label.value, 'Give the category a name.'))
  ) {
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await api.createDiaryCategory({
      slug: suggestCategorySlug(label.value),
      label: label.value.trim(),
      colour: colour.value,
      sortOrder: (categories.value.at(-1)?.sortOrder ?? 0) + 10,
    });
    label.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not add that category.';
  } finally {
    saving.value = false;
  }
}

async function update(
  category: DiaryCategory,
  changes: Parameters<typeof api.updateDiaryCategory>[1],
): Promise<void> {
  error.value = '';
  try {
    await api.updateDiaryCategory(category.id, changes);
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that change.';
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Diary categories</h1>
      <p class="text-text-secondary mt-1">
        What staff can file a diary entry under. Turning one off hides it from the picker and leaves
        every entry already filed under it exactly as it is.
      </p>
    </div>

    <FormError :message="guard.problem.value?.message ?? error" />

    <form class="card flex flex-wrap items-end gap-3 p-4" @submit.prevent="add">
      <div class="min-w-48 flex-1">
        <label class="field-label" for="category-label">Name</label>
        <input
          id="category-label"
          v-model="label"
          type="text"
          class="field"
          maxlength="60"
          :aria-invalid="guard.invalid('category-label')"
          @input="guard.clear()"
        />
      </div>
      <div class="min-w-40">
        <label class="field-label" for="category-colour">Colour</label>
        <select id="category-colour" v-model="colour" class="field">
          <option v-for="option in diaryCategoryColours" :key="option" :value="option">
            {{ option }}
          </option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary" :disabled="saving">Add category</button>
    </form>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <ul v-else class="space-y-2">
      <li
        v-for="category in categories"
        :key="category.id"
        class="card flex flex-wrap items-center gap-3 p-3"
        :class="category.active ? '' : 'opacity-60'"
      >
        <CategoryChip :label="category.label" :colour="category.colour" />
        <span class="text-text-secondary text-sm">{{ category.slug }}</span>
        <span v-if="!category.active" class="text-text-secondary text-sm">Not in use</span>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <select
            class="field w-40"
            :value="category.colour"
            :aria-label="`Colour for ${category.label}`"
            @change="
              update(category, {
                colour: ($event.target as HTMLSelectElement).value as DiaryCategoryColour,
              })
            "
          >
            <option v-for="option in diaryCategoryColours" :key="option" :value="option">
              {{ option }}
            </option>
          </select>

          <button
            type="button"
            class="btn border-border-default min-h-11 border px-3 text-sm"
            @click="update(category, { active: !category.active })"
          >
            {{ category.active ? 'Turn off' : 'Turn back on' }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
