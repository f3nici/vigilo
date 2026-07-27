<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { canManageTemplates, type CheckTemplate } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { formatDateTime } from '@/lib/format';

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

async function create(): Promise<void> {
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

    <FormError :message="error" />

    <form v-if="canManage" class="card flex flex-wrap items-end gap-3 p-4" @submit.prevent="create">
      <div class="min-w-56 flex-1">
        <label class="field-label" for="template-name">Name</label>
        <input
          id="template-name"
          v-model="name"
          class="field"
          type="text"
          required
          placeholder="Vent observations"
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
      <button class="btn btn-primary" type="submit" :disabled="creating || name.trim() === ''">
        {{ creating ? 'Creating…' : 'New check form' }}
      </button>
    </form>

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
          </div>
        </div>

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
