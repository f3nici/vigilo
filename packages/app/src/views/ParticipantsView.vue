<script setup lang="ts">
import { onMounted, ref } from 'vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';

/**
 * Phase 1 shows what the scope layer returns and nothing more. Names and every
 * other encrypted field arrive in Phase 2 along with the record itself.
 */
const session = useSessionStore();
const participants = ref<{ id: string; status: string }[]>([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    participants.value = await api.listParticipants();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load participants.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-semibold">Participants</h1>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else-if="participants.length === 0" class="card p-6">
      <p class="font-medium">No participants in your scope.</p>
      <p class="text-text-secondary mt-1">
        {{
          session.principal?.role === 'admin'
            ? 'Participant records arrive in Phase 2. An admin will add them from here.'
            : 'You will see people here once an admin assigns them to you.'
        }}
      </p>
    </div>

    <div v-else class="card p-4">
      <p class="text-text-secondary text-sm">
        {{ participants.length }} in your scope. Records themselves arrive in Phase 2.
      </p>
      <ul class="mt-3 space-y-1">
        <li v-for="participant in participants" :key="participant.id" class="tabular text-sm">
          {{ participant.id }} ({{ participant.status }})
        </li>
      </ul>
    </div>
  </div>
</template>
