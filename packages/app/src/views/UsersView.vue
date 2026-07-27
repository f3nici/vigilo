<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { roles, totpRequired, type Role, type UserSummary } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import OneTimePassword from '@/components/OneTimePassword.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';

/**
 * Account administration (doc 01 §10).
 *
 * There is no email, so a new account's password is shown here once for the
 * admin to hand over directly. That is the whole credential-issuing flow.
 */
const session = useSessionStore();

const users = ref<UserSummary[]>([]);
const loading = ref(true);
const error = ref('');

const showCreate = ref(false);
const draft = ref({ email: '', displayName: '', role: 'worker' as Role });
const creating = ref(false);

/** Held only in memory, only until the admin dismisses it. */
const issued = ref<{ email: string; password: string } | null>(null);

// Participant self-access accounts are created from a participant record in a
// later phase, where the participant to link is actually in front of you.
const creatableRoles = roles.filter((role) => role !== 'participant');

function report(err: unknown, fallback: string): void {
  error.value = err instanceof ApiRequestError ? err.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    users.value = await api.listUsers();
  } catch (err) {
    report(err, 'Could not load the list of people.');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function create(): Promise<void> {
  creating.value = true;
  error.value = '';
  try {
    const result = await api.createUser(draft.value);
    issued.value = { email: result.user.email, password: result.oneTimePassword };
    showCreate.value = false;
    draft.value = { email: '', displayName: '', role: 'worker' };
    await load();
  } catch (err) {
    report(err, 'Could not create that account.');
  } finally {
    creating.value = false;
  }
}

async function act(user: UserSummary, action: 'suspend' | 'reinstate' | 'reset-totp' | 'unlock') {
  error.value = '';
  try {
    if (action === 'suspend') await api.suspendUser(user.id);
    if (action === 'reinstate') await api.reinstateUser(user.id);
    if (action === 'reset-totp') await api.resetUserTotp(user.id);
    if (action === 'unlock') await api.unlockUser(user.id);
    await load();
  } catch (err) {
    report(err, 'That did not work.');
  }
}

async function resetPassword(user: UserSummary): Promise<void> {
  error.value = '';
  try {
    const result = await api.resetUserPassword(user.id);
    issued.value = { email: result.user.email, password: result.oneTimePassword };
    await load();
  } catch (err) {
    report(err, 'Could not reset that password.');
  }
}

const roleLabels: Record<Role, string> = {
  admin: 'Admin',
  team_leader: 'Team leader',
  nurse: 'Nurse',
  worker: 'Support worker',
  participant: 'Participant',
};

function isLocked(user: UserSummary): boolean {
  return user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center gap-4">
      <h1 class="text-2xl font-semibold">People</h1>
      <button class="btn btn-primary ml-auto" type="button" @click="showCreate = !showCreate">
        {{ showCreate ? 'Cancel' : 'Add someone' }}
      </button>
    </div>

    <FormError :message="error" />

    <OneTimePassword
      v-if="issued"
      :email="issued.email"
      :password="issued.password"
      @dismiss="issued = null"
    />

    <form v-if="showCreate" class="card space-y-4 p-4" @submit.prevent="create">
      <h2 class="text-lg font-semibold">Add someone</h2>

      <div>
        <label class="field-label" for="new-email">Email</label>
        <input
          id="new-email"
          v-model="draft.email"
          class="field"
          type="email"
          inputmode="email"
          required
        />
        <p class="text-text-secondary mt-1 text-sm">
          Used to sign in. Vigilo never sends email to it.
        </p>
      </div>

      <div>
        <label class="field-label" for="new-name">Name</label>
        <input id="new-name" v-model="draft.displayName" class="field" type="text" required />
      </div>

      <div>
        <label class="field-label" for="new-role">Role</label>
        <select id="new-role" v-model="draft.role" class="field">
          <option v-for="role in creatableRoles" :key="role" :value="role">
            {{ roleLabels[role] }}
          </option>
        </select>
        <p class="text-text-secondary mt-1 text-sm">
          {{
            totpRequired(draft.role)
              ? 'This role must set up two-factor authentication before it can be used.'
              : 'Two-factor is optional for this role.'
          }}
        </p>
      </div>

      <button class="btn btn-primary" type="submit" :disabled="creating">
        {{ creating ? 'Creating' : 'Create and show password' }}
      </button>
    </form>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <div v-else-if="users.length === 0" class="card p-6">
      <p class="font-medium">Nobody here yet.</p>
      <p class="text-text-secondary mt-1">Add someone to get started.</p>
    </div>

    <ul v-else class="space-y-3">
      <li v-for="user in users" :key="user.id" class="card p-4">
        <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div class="min-w-0">
            <p class="font-semibold">
              {{ user.displayName }}
              <span v-if="user.id === session.principal?.userId" class="text-text-secondary">
                (you)
              </span>
            </p>
            <p class="text-text-secondary text-sm break-all">{{ user.email }}</p>
          </div>

          <div class="text-text-secondary flex flex-wrap items-center gap-2 text-sm">
            <span class="border-border-default rounded-full border px-2 py-0.5">
              {{ roleLabels[user.role] }}
            </span>
            <span
              v-if="user.status !== 'active'"
              class="rounded-full border px-2 py-0.5"
              :style="{ borderColor: 'var(--vigilo-missed)', color: 'var(--vigilo-missed)' }"
            >
              {{ user.status === 'suspended' ? 'Suspended' : 'Archived' }}
            </span>
            <span
              v-if="isLocked(user)"
              class="rounded-full border px-2 py-0.5"
              :style="{ borderColor: 'var(--vigilo-partial)', color: 'var(--vigilo-partial)' }"
            >
              Locked out
            </span>
            <span
              v-if="user.mustChangePassword"
              class="border-border-default rounded-full border px-2 py-0.5"
            >
              Password not changed yet
            </span>
            <span class="border-border-default rounded-full border px-2 py-0.5">
              {{ user.totpEnabled ? 'Two-factor on' : 'No two-factor' }}
            </span>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap gap-2 text-sm">
          <button
            class="btn min-h-11 border-border-default border px-3"
            type="button"
            @click="resetPassword(user)"
          >
            Reset password
          </button>
          <button
            v-if="isLocked(user)"
            class="btn min-h-11 border-border-default border px-3"
            type="button"
            @click="act(user, 'unlock')"
          >
            Unlock
          </button>
          <button
            v-if="user.totpEnabled"
            class="btn min-h-11 border-border-default border px-3"
            type="button"
            @click="act(user, 'reset-totp')"
          >
            Reset two-factor
          </button>
          <button
            v-if="user.status === 'active' && user.id !== session.principal?.userId"
            class="btn btn-destructive min-h-11 px-3"
            type="button"
            @click="act(user, 'suspend')"
          >
            Suspend
          </button>
          <button
            v-if="user.status === 'suspended'"
            class="btn min-h-11 border-border-default border px-3"
            type="button"
            @click="act(user, 'reinstate')"
          >
            Reinstate
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
