<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  createParticipantRequestSchema,
  describeIssues,
  issuesByField,
  type CreateParticipantRequest,
  type UpdateParticipantRequest,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * Add or edit a participant. The same form either way, because the fields are
 * the same and two of them would drift.
 *
 * Validation uses the schema the API validates against, so the form cannot
 * accept something the request will reject.
 */
const route = useRoute();
const router = useRouter();

const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const editing = computed(() => id.value !== null);

const draft = ref({
  firstName: '',
  lastName: '',
  preferredName: '',
  dateOfBirth: '',
  ndisNumber: '',
  address: '',
  phone: '',
  email: '',
  notes: '',
});

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const fieldErrors = ref<Record<string, string>>({});

onMounted(async () => {
  if (!editing.value || id.value === null) return;
  loading.value = true;
  try {
    const participant = await api.getParticipant(id.value);
    draft.value = {
      firstName: participant.firstName,
      lastName: participant.lastName,
      preferredName: participant.preferredName ?? '',
      dateOfBirth: participant.dateOfBirth,
      ndisNumber: participant.ndisNumber,
      address: participant.address ?? '',
      phone: participant.phone ?? '',
      email: participant.email ?? '',
      notes: participant.notes ?? '',
    };
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load that record.';
  } finally {
    loading.value = false;
  }
});

/** Empty means "no value", which on the wire is null rather than "". */
function orNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function payload(): CreateParticipantRequest & UpdateParticipantRequest {
  return {
    firstName: draft.value.firstName.trim(),
    lastName: draft.value.lastName.trim(),
    preferredName: orNull(draft.value.preferredName),
    dateOfBirth: draft.value.dateOfBirth,
    ndisNumber: draft.value.ndisNumber,
    address: orNull(draft.value.address),
    phone: orNull(draft.value.phone),
    email: orNull(draft.value.email),
    notes: orNull(draft.value.notes),
  };
}

async function submit(): Promise<void> {
  error.value = '';
  fieldErrors.value = {};

  const parsed = createParticipantRequestSchema.safeParse(payload());
  if (!parsed.success) {
    fieldErrors.value = issuesByField(parsed.error.issues);
    error.value = describeIssues(parsed.error.issues);
    return;
  }

  saving.value = true;
  try {
    const saved =
      editing.value && id.value !== null
        ? await api.updateParticipant(id.value, parsed.data)
        : await api.createParticipant(parsed.data);

    await router.push({ name: 'participant', params: { id: saved.id } });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that record.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="max-w-2xl space-y-5">
    <h1 class="text-2xl font-semibold">
      {{ editing ? 'Edit participant' : 'Add a participant' }}
    </h1>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <form v-else class="card space-y-4 p-5" @submit.prevent="submit">
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="first-name">First name</label>
          <input id="first-name" v-model="draft.firstName" class="field" type="text" required />
          <p
            v-if="fieldErrors.firstName"
            class="mt-1 text-sm"
            :style="{ color: 'var(--vigilo-missed)' }"
          >
            {{ fieldErrors.firstName }}
          </p>
        </div>

        <div>
          <label class="field-label" for="last-name">Last name</label>
          <input id="last-name" v-model="draft.lastName" class="field" type="text" required />
          <p
            v-if="fieldErrors.lastName"
            class="mt-1 text-sm"
            :style="{ color: 'var(--vigilo-missed)' }"
          >
            {{ fieldErrors.lastName }}
          </p>
        </div>

        <div>
          <label class="field-label" for="preferred-name">Preferred name</label>
          <input id="preferred-name" v-model="draft.preferredName" class="field" type="text" />
          <p class="text-text-secondary mt-1 text-sm">What staff should call them.</p>
        </div>

        <div>
          <label class="field-label" for="dob">Date of birth</label>
          <input id="dob" v-model="draft.dateOfBirth" class="field" type="date" required />
          <p
            v-if="fieldErrors.dateOfBirth"
            class="mt-1 text-sm"
            :style="{ color: 'var(--vigilo-missed)' }"
          >
            {{ fieldErrors.dateOfBirth }}
          </p>
        </div>

        <div>
          <label class="field-label" for="ndis">NDIS number</label>
          <input
            id="ndis"
            v-model="draft.ndisNumber"
            class="field tabular"
            type="text"
            inputmode="numeric"
            required
          />
          <p
            v-if="fieldErrors.ndisNumber"
            class="mt-1 text-sm"
            :style="{ color: 'var(--vigilo-missed)' }"
          >
            {{ fieldErrors.ndisNumber }}
          </p>
        </div>

        <div>
          <label class="field-label" for="phone">Phone</label>
          <input id="phone" v-model="draft.phone" class="field" type="tel" inputmode="tel" />
        </div>
      </div>

      <div>
        <label class="field-label" for="address">Address</label>
        <textarea id="address" v-model="draft.address" class="field" rows="2"></textarea>
      </div>

      <div>
        <label class="field-label" for="email">Email</label>
        <input id="email" v-model="draft.email" class="field" type="email" inputmode="email" />
      </div>

      <div>
        <label class="field-label" for="notes">Admin notes</label>
        <textarea id="notes" v-model="draft.notes" class="field" rows="3"></textarea>
        <p class="text-text-secondary mt-1 text-sm">
          Practical notes about supporting this person. Anything that happened on a day belongs in
          the diary.
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary" type="submit" :disabled="saving">
          {{ saving ? 'Saving' : editing ? 'Save changes' : 'Add participant' }}
        </button>
        <button class="btn border-border-default border" type="button" @click="router.back()">
          Cancel
        </button>
      </div>
    </form>
  </div>
</template>
