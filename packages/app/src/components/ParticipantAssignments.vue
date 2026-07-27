<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ParticipantAssignment, UserSummary } from '@vigilo/shared';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDateTime, timeRemaining } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

/**
 * Who can see this participant (doc 01 §4.1).
 *
 * A temporary grant needs an expiry and a reason, both required by the form
 * because they are required by the API. Revoked grants stay on the list: who
 * had access and when is part of the record.
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();

const assignments = ref<ParticipantAssignment[]>([]);
const staff = ref<UserSummary[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const showForm = ref(false);

const draft = ref({
  userId: '',
  kind: 'standing' as 'standing' | 'temporary',
  expiresAt: '',
  reason: '',
});

/** Only an admin can list every account, so the picker is admin-only. */
const canPickFromList = computed(() => session.principal?.role === 'admin');

const effective = computed(() => assignments.value.filter((a) => a.effective));
const past = computed(() => assignments.value.filter((a) => !a.effective));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    assignments.value = await api.listAssignments(props.participantId);
    if (canPickFromList.value && staff.value.length === 0) {
      staff.value = (await api.listUsers()).filter(
        (user) => user.role !== 'participant' && user.status === 'active',
      );
    }
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load who has access.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function grant(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.grantAssignment(props.participantId, {
      userId: draft.value.userId,
      kind: draft.value.kind,
      ...(draft.value.kind === 'temporary'
        ? {
            expiresAt: new Date(draft.value.expiresAt).toISOString(),
            reason: draft.value.reason.trim(),
          }
        : {}),
    });
    showForm.value = false;
    draft.value = { userId: '', kind: 'standing', expiresAt: '', reason: '' };
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not give that access.';
  } finally {
    busy.value = false;
  }
}

async function revoke(assignment: ParticipantAssignment): Promise<void> {
  error.value = '';
  try {
    await api.revokeAssignment(assignment.id);
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not take that access away.';
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Who has access</h2>
      <button
        class="btn border-border-default ml-auto border px-3"
        type="button"
        @click="showForm = !showForm"
      >
        {{ showForm ? 'Cancel' : 'Give someone access' }}
      </button>
    </div>

    <p v-if="error" class="text-sm" :style="{ color: 'var(--vigilo-missed)' }">{{ error }}</p>

    <form v-if="showForm" class="card space-y-3 p-4" @submit.prevent="grant">
      <div>
        <label class="field-label" for="assign-user">Person</label>
        <select
          v-if="canPickFromList"
          id="assign-user"
          v-model="draft.userId"
          class="field"
          required
        >
          <option value="" disabled>Choose someone</option>
          <option v-for="user in staff" :key="user.id" :value="user.id">
            {{ user.displayName }} ({{ user.email }})
          </option>
        </select>
        <input
          v-else
          id="assign-user"
          v-model="draft.userId"
          class="field"
          type="text"
          required
          placeholder="Their user id"
        />
      </div>

      <div>
        <label class="field-label" for="assign-kind">Kind of access</label>
        <select id="assign-kind" v-model="draft.kind" class="field">
          <option value="standing">Ongoing, until it is taken away</option>
          <option value="temporary">Temporary, ends by itself</option>
        </select>
      </div>

      <template v-if="draft.kind === 'temporary'">
        <div>
          <label class="field-label" for="assign-expiry">Ends at</label>
          <input
            id="assign-expiry"
            v-model="draft.expiresAt"
            class="field"
            type="datetime-local"
            required
          />
        </div>
        <div>
          <label class="field-label" for="assign-reason">Reason</label>
          <input
            id="assign-reason"
            v-model="draft.reason"
            class="field"
            type="text"
            required
            placeholder="Covering tonight's shift"
          />
          <p class="text-text-secondary mt-1 text-sm">Recorded in the audit log.</p>
        </div>
      </template>

      <button class="btn btn-primary" type="submit" :disabled="busy">
        {{ busy ? 'Saving' : 'Give access' }}
      </button>
    </form>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <p v-if="effective.length === 0" class="text-text-secondary">Nobody has access yet.</p>

      <ul v-else class="space-y-2">
        <li
          v-for="assignment in effective"
          :key="assignment.id"
          class="card flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
        >
          <div class="min-w-0">
            <p class="font-semibold">{{ assignment.userDisplayName }}</p>
            <p class="text-text-secondary text-sm">
              {{ assignment.kind === 'temporary' ? 'Temporary' : 'Ongoing' }}
              <span v-if="assignment.expiresAt"> · {{ timeRemaining(assignment.expiresAt) }} </span>
              <span v-if="assignment.reason"> · {{ assignment.reason }}</span>
            </p>
          </div>

          <button
            class="btn btn-destructive ml-auto min-h-11 px-3 text-sm"
            type="button"
            @click="revoke(assignment)"
          >
            Take access away
          </button>
        </li>
      </ul>

      <details v-if="past.length > 0" class="text-text-secondary text-sm">
        <summary class="min-h-11 cursor-pointer">
          {{ past.length }} past {{ past.length === 1 ? 'grant' : 'grants' }}
        </summary>
        <ul class="mt-2 space-y-1">
          <li v-for="assignment in past" :key="assignment.id">
            {{ assignment.userDisplayName }} ·
            {{ assignment.revokedAt ? 'taken away' : 'expired' }}
            {{
              formatDateTime(assignment.revokedAt ?? assignment.expiresAt ?? assignment.grantedAt)
            }}
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>
