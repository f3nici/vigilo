<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  canManageParticipants,
  compareParticipants,
  describeIssues,
  describeOutstanding,
  emptyOutstanding,
  matchesParticipantSearch,
  ndisNumberSchema,
  participantDisplayName,
  summariseOutstanding,
  type ParticipantSummary,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { readParticipants, readToday } from '@/lib/records';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { timeRemaining } from '@/lib/format';

/**
 * The participant list (doc 06 §4.1).
 *
 * Filtering happens here, in the browser, over the already-decrypted list. The
 * names are encrypted in the database, so searching them server-side would mean
 * decrypting every row on every keystroke.
 */
const session = useSessionStore();
const router = useRouter();

const participants = ref<ParticipantSummary[]>([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const includeArchived = ref(false);

const ndis = ref('');
const lookingUp = ref(false);
const lookupResult = ref('');

const isAdmin = computed(() => canManageParticipants(session.principal?.role ?? 'worker'));

/**
 * What each person still needs (D90).
 *
 * This list is the worker's home now, so it has to answer the question Today
 * used to: which of these people needs me. Read from the same feed Today does,
 * so the two never disagree.
 *
 * Its absence is not an error. The list has to render with no signal and
 * before the windows arrive, and a participant with no counts simply shows a
 * name, which is what the screen was before.
 */
const outstanding = ref(new Map<string, ReturnType<typeof emptyOutstanding>>());

async function loadOutstanding(): Promise<void> {
  try {
    const today = await readToday();
    outstanding.value = summariseOutstanding(today.windows);
  } catch {
    // No signal and nothing local yet. The names still matter.
  }
}

const visible = computed(() =>
  participants.value
    .filter((participant) => matchesParticipantSearch(participant, search.value))
    .sort(compareParticipants),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    /*
     * Local first. Doc 01 §11 lists seeing your assigned participants as
     * something that works with no connection, and it is the way in to the
     * emergency panel and the care plan, which must both work offline.
     *
     * Archived people are only on the server: the device holds who you are
     * working with now.
     */
    participants.value = includeArchived.value
      ? await api.listParticipants({ includeArchived: true })
      : await readParticipants();
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not load the participant list.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  void loadOutstanding();
});

/**
 * Exact match on the NDIS number, which is the one thing the server can look up
 * without decrypting: the blind index is an HMAC, so there is no partial match
 * and no "starts with". Useful for checking whether someone is already on the
 * system before adding them again.
 */
async function lookup(): Promise<void> {
  const parsed = ndisNumberSchema.safeParse(ndis.value);
  if (!parsed.success) {
    lookupResult.value = describeIssues(parsed.error.issues);
    return;
  }

  lookingUp.value = true;
  lookupResult.value = '';
  try {
    const found = await api.lookupByNdisNumber(parsed.data);
    if (found) {
      await router.push({ name: 'participant', params: { id: found.id } });
    } else {
      lookupResult.value = 'Nobody on the system has that NDIS number.';
    }
  } catch (err) {
    lookupResult.value = err instanceof ApiRequestError ? err.message : 'That lookup failed.';
  } finally {
    lookingUp.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-semibold">Participants</h1>
      <RouterLink v-if="isAdmin" class="btn btn-primary ml-auto" :to="{ name: 'participant-new' }">
        Add a participant
      </RouterLink>
    </div>

    <FormError :message="error" />

    <div class="flex flex-wrap items-end gap-4">
      <div class="min-w-56 flex-1">
        <label class="field-label" for="participant-search">Search</label>
        <input
          id="participant-search"
          v-model="search"
          class="field"
          type="search"
          placeholder="Name or preferred name"
        />
      </div>

      <label v-if="isAdmin" class="flex min-h-12 items-center gap-2 text-sm">
        <input v-model="includeArchived" type="checkbox" class="size-5" @change="load" />
        Show archived
      </label>
    </div>

    <form v-if="isAdmin" class="flex flex-wrap items-end gap-3" @submit.prevent="lookup">
      <div class="min-w-56">
        <label class="field-label" for="ndis-lookup">Find by NDIS number</label>
        <input
          id="ndis-lookup"
          v-model="ndis"
          class="field tabular"
          type="text"
          inputmode="numeric"
          placeholder="431 234 567"
        />
      </div>
      <button class="btn border-border-default border" type="submit" :disabled="lookingUp">
        {{ lookingUp ? 'Looking' : 'Look up' }}
      </button>
      <p v-if="lookupResult" class="text-text-secondary min-h-12 self-center text-sm">
        {{ lookupResult }}
      </p>
    </form>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else-if="participants.length === 0" class="card p-6">
      <p class="font-medium">No participants in your scope.</p>
      <p class="text-text-secondary mt-1">
        {{
          isAdmin
            ? 'Add the first one to get started.'
            : 'You will see people here once someone assigns them to you.'
        }}
      </p>
    </div>

    <p v-else-if="visible.length === 0" class="text-text-secondary">
      Nobody matches "{{ search }}".
    </p>

    <ul v-else class="space-y-3">
      <li v-for="participant in visible" :key="participant.id">
        <RouterLink
          class="card hover:border-primary block p-4"
          :to="{ name: 'participant', params: { id: participant.id } }"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p class="text-lg font-semibold">
              {{ participantDisplayName(participant) }}
            </p>
            <p v-if="participant.preferredName" class="text-text-secondary text-sm">
              {{ participant.firstName }} {{ participant.lastName }}
            </p>

            <div class="ml-auto flex flex-wrap items-center gap-2 text-sm">
              <span
                v-if="outstanding.get(participant.id)?.needsReason"
                class="rounded-full border px-2 py-0.5"
                :style="{ borderColor: 'var(--vigilo-missed)', color: 'var(--vigilo-missed)' }"
              >
                Needs a reason
              </span>
              <span
                v-if="participant.status === 'archived'"
                class="rounded-full border px-2 py-0.5"
                :style="{
                  borderColor: 'var(--vigilo-not-expected)',
                  color: 'var(--vigilo-not-expected)',
                }"
              >
                Archived
              </span>
              <span
                v-if="participant.access.kind === 'temporary' && participant.access.expiresAt"
                class="rounded-full border px-2 py-0.5"
                :style="{ borderColor: 'var(--vigilo-partial)', color: 'var(--vigilo-partial)' }"
              >
                Temporary access, {{ timeRemaining(participant.access.expiresAt) }}
              </span>
            </div>
          </div>

          <!--
            Colour is never the only signal, so the counts are spelled out as
            words underneath rather than left to the pill above.
          -->
          <p
            v-if="describeOutstanding(outstanding.get(participant.id) ?? emptyOutstanding())"
            class="text-text-secondary mt-1 text-sm"
          >
            {{ describeOutstanding(outstanding.get(participant.id) ?? emptyOutstanding()) }}
          </p>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
