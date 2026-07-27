<script setup lang="ts">
import { ref } from 'vue';
import type { EmergencyContact } from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * Emergency contacts, primary first (doc 01 §4). In an emergency nobody
 * scrolls, so the order is deliberate rather than whatever came back.
 */
const props = defineProps<{
  participantId: string;
  contacts: EmergencyContact[];
  canEdit: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const showForm = ref(false);
const editingId = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const confirmingDelete = ref<string | null>(null);

const empty = {
  name: '',
  relationship: '',
  phonePrimary: '',
  phoneSecondary: '',
  email: '',
  notes: '',
  isPrimary: false,
};

const draft = ref({ ...empty });

function startNew(): void {
  editingId.value = null;
  draft.value = { ...empty };
  showForm.value = true;
}

function startEdit(contact: EmergencyContact): void {
  editingId.value = contact.id;
  draft.value = {
    name: contact.name,
    relationship: contact.relationship,
    phonePrimary: contact.phonePrimary,
    phoneSecondary: contact.phoneSecondary ?? '',
    email: contact.email ?? '',
    notes: contact.notes ?? '',
    isPrimary: contact.isPrimary,
  };
  showForm.value = true;
}

function orNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  const payload = {
    name: draft.value.name.trim(),
    relationship: draft.value.relationship.trim(),
    phonePrimary: draft.value.phonePrimary.trim(),
    phoneSecondary: orNull(draft.value.phoneSecondary),
    email: orNull(draft.value.email),
    notes: orNull(draft.value.notes),
    isPrimary: draft.value.isPrimary,
  };

  try {
    if (editingId.value) {
      await api.updateContact(props.participantId, editingId.value, payload);
    } else {
      await api.createContact(props.participantId, payload);
    }
    showForm.value = false;
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that contact.';
  } finally {
    busy.value = false;
  }
}

async function remove(contact: EmergencyContact): Promise<void> {
  error.value = '';
  try {
    await api.deleteContact(props.participantId, contact.id);
    confirmingDelete.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not remove that contact.';
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Emergency contacts</h2>
      <button
        v-if="canEdit"
        class="btn border-border-default ml-auto border px-3"
        type="button"
        @click="startNew"
      >
        Add a contact
      </button>
    </div>

    <p v-if="error" class="text-sm" :style="{ color: 'var(--vigilo-missed)' }">{{ error }}</p>

    <form v-if="showForm" class="card space-y-3 p-4" @submit.prevent="save">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="contact-name">Name</label>
          <input id="contact-name" v-model="draft.name" class="field" type="text" required />
        </div>
        <div>
          <label class="field-label" for="contact-relationship">Relationship</label>
          <input
            id="contact-relationship"
            v-model="draft.relationship"
            class="field"
            type="text"
            required
            placeholder="Mother, brother, GP"
          />
        </div>
        <div>
          <label class="field-label" for="contact-phone">Phone</label>
          <input
            id="contact-phone"
            v-model="draft.phonePrimary"
            class="field"
            type="tel"
            inputmode="tel"
            required
          />
        </div>
        <div>
          <label class="field-label" for="contact-phone-2">Another phone</label>
          <input
            id="contact-phone-2"
            v-model="draft.phoneSecondary"
            class="field"
            type="tel"
            inputmode="tel"
          />
        </div>
        <div>
          <label class="field-label" for="contact-email">Email</label>
          <input id="contact-email" v-model="draft.email" class="field" type="email" />
        </div>
        <div>
          <label class="field-label" for="contact-notes">Notes</label>
          <input id="contact-notes" v-model="draft.notes" class="field" type="text" />
        </div>
      </div>

      <label class="flex min-h-11 items-center gap-2">
        <input v-model="draft.isPrimary" type="checkbox" class="size-5" />
        Call this person first
      </label>

      <div class="flex gap-2">
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? 'Saving' : 'Save contact' }}
        </button>
        <button class="btn border-border-default border" type="button" @click="showForm = false">
          Cancel
        </button>
      </div>
    </form>

    <p v-if="contacts.length === 0" class="text-text-secondary">No emergency contacts recorded.</p>

    <ul v-else class="space-y-2">
      <li v-for="contact in contacts" :key="contact.id" class="card p-4">
        <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div class="min-w-0 flex-1">
            <p class="font-semibold">
              {{ contact.name }}
              <span
                v-if="contact.isPrimary"
                class="ml-2 rounded-full border px-2 py-0.5 text-sm font-normal"
                :style="{ borderColor: 'var(--vigilo-primary)', color: 'var(--vigilo-primary)' }"
              >
                Call first
              </span>
            </p>
            <p class="text-text-secondary text-sm">{{ contact.relationship }}</p>
            <p class="tabular mt-1">
              <a class="underline" :href="`tel:${contact.phonePrimary}`">{{
                contact.phonePrimary
              }}</a>
              <span v-if="contact.phoneSecondary">
                ·
                <a class="underline" :href="`tel:${contact.phoneSecondary}`">
                  {{ contact.phoneSecondary }}
                </a>
              </span>
            </p>
            <p v-if="contact.email" class="text-text-secondary text-sm break-all">
              {{ contact.email }}
            </p>
            <p v-if="contact.notes" class="text-text-secondary mt-1 text-sm">{{ contact.notes }}</p>
          </div>

          <div v-if="canEdit" class="flex flex-wrap gap-2 text-sm">
            <button
              class="btn border-border-default min-h-11 border px-3"
              type="button"
              @click="startEdit(contact)"
            >
              Edit
            </button>
            <button
              v-if="confirmingDelete !== contact.id"
              class="btn btn-destructive min-h-11 px-3"
              type="button"
              @click="confirmingDelete = contact.id"
            >
              Remove
            </button>
            <template v-else>
              <button
                class="btn btn-destructive min-h-11 px-3"
                type="button"
                @click="remove(contact)"
              >
                Yes, remove
              </button>
              <button
                class="btn border-border-default min-h-11 border px-3"
                type="button"
                @click="confirmingDelete = null"
              >
                Keep
              </button>
            </template>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
