<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AssignableStaff, ParticipantAssignment } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDateTime, timeRemaining } from '@/lib/format';
import { needs, needsChoice, useFormGuard } from '@/lib/forms';

/**
 * The support team (doc 01 §4.1, D87).
 *
 * Who works with this person, as a list you tick. Assigning a house of six
 * workers one at a time through a form was how a participant ended up with
 * nobody assigned, and a participant with nobody assigned is one nobody is
 * notified about and nobody can open.
 *
 * Two things live here and they are deliberately separate. The tick list is
 * ongoing membership, changed in one save. Underneath it, temporary grants,
 * which carry an expiry and a reason and are given and taken away one at a
 * time, because each one is a decision about a particular shift.
 */
const props = defineProps<{ participantId: string }>();

const staff = ref<AssignableStaff[]>([]);
const assignments = ref<ParticipantAssignment[]>([]);
const chosen = ref(new Set<string>());
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const showTemporary = ref(false);

const guard = useFormGuard();

const draft = ref({ userId: '', expiresAt: '', reason: '' });

/** Ongoing membership only. A temporary grant is shown but never ticked away. */
const ongoing = computed(() => staff.value.filter((person) => person.temporaryUntil === null));
const covering = computed(() => staff.value.filter((person) => person.temporaryUntil !== null));

const dirty = computed(
  () =>
    ongoing.value.some((person) => person.assigned !== chosen.value.has(person.id)) ||
    covering.value.some((person) => !chosen.value.has(person.id)),
);

const past = computed(() => assignments.value.filter((one) => !one.effective));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [team, history] = await Promise.all([
      api.listSupportTeam(props.participantId),
      api.listAssignments(props.participantId),
    ]);
    staff.value = team;
    assignments.value = history;
    reset();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the support team.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function reset(): void {
  chosen.value = new Set(
    staff.value.filter((person) => person.assigned).map((person) => person.id),
  );
}

function toggle(id: string): void {
  const next = new Set(chosen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosen.value = next;
  notice.value = '';
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await api.setSupportTeam(props.participantId, [...chosen.value]);
    staff.value = result.staff;
    assignments.value = await api.listAssignments(props.participantId);
    reset();

    const parts: string[] = [];
    if (result.change.added.length > 0) parts.push(`Added ${result.change.added.join(', ')}.`);
    if (result.change.removed.length > 0)
      parts.push(`Removed ${result.change.removed.join(', ')}.`);
    if (result.change.keptTemporary.length > 0) {
      // Said out loud rather than silently ignored. Somebody unticked a name
      // and it stayed ticked, and they are entitled to know why.
      parts.push(
        `${result.change.keptTemporary.join(', ')} kept temporary access, which has to be taken away below.`,
      );
    }
    notice.value = parts.length > 0 ? parts.join(' ') : 'Nothing changed.';
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save the team.';
  } finally {
    saving.value = false;
  }
}

async function grantTemporary(): Promise<void> {
  if (
    !guard.ready(
      needsChoice('cover-user', draft.value.userId, 'Choose who is covering.'),
      needs('cover-expiry', draft.value.expiresAt !== '', 'Say when the cover ends.'),
      needsChoice('cover-reason', draft.value.reason.trim(), 'Say why, for the audit log.'),
    )
  ) {
    return;
  }

  error.value = '';
  try {
    await api.grantAssignment(props.participantId, {
      userId: draft.value.userId,
      kind: 'temporary',
      expiresAt: new Date(draft.value.expiresAt).toISOString(),
      reason: draft.value.reason.trim(),
    });
    draft.value = { userId: '', expiresAt: '', reason: '' };
    showTemporary.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not give that access.';
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

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  team_leader: 'Team leader',
  nurse: 'Nurse',
  worker: 'Support worker',
  participant: 'Participant',
};
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold">Support team</h2>
      <p class="text-text-secondary mt-1 text-sm">
        Who works with this person. Everyone ticked can open the record and is told when a check is
        due. Tick as many as you need and save once.
      </p>
    </div>

    <FormError :message="guard.problem.value?.message ?? error" />
    <p v-if="notice" class="text-text-secondary text-sm">{{ notice }}</p>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <div class="card p-4">
        <ul class="space-y-1">
          <li v-for="person in ongoing" :key="person.id">
            <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2">
              <input
                type="checkbox"
                class="size-5"
                :checked="chosen.has(person.id)"
                @change="toggle(person.id)"
              />
              <span class="font-medium">{{ person.displayName }}</span>
              <span class="text-text-secondary text-sm">{{ roleLabels[person.role] }}</span>
            </label>
          </li>
        </ul>

        <p v-if="ongoing.length === 0" class="text-text-secondary">
          There are no staff accounts to assign yet.
        </p>

        <!--
          Temporary cover, listed with the ongoing team so the list is not a
          half-truth, but not tickable: unticking one would quietly end a shift
          somebody arranged for a reason.
        -->
        <ul v-if="covering.length > 0" class="border-border-default mt-3 border-t pt-3">
          <li
            v-for="person in covering"
            :key="person.id"
            class="flex min-h-11 flex-wrap items-center gap-x-3 px-2"
          >
            <span class="font-medium">{{ person.displayName }}</span>
            <span class="text-text-secondary text-sm">
              covering, ends {{ timeRemaining(person.temporaryUntil!) }}
            </span>
          </li>
        </ul>

        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? 'Saving…' : 'Save the team' }}
          </button>
          <button
            v-if="dirty"
            type="button"
            class="btn border-border-default border"
            @click="
              reset();
              notice = '';
            "
          >
            Undo my changes
          </button>
        </div>
      </div>

      <!-- Temporary cover. One at a time, because each one is its own decision. -->
      <div class="card p-4">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="font-semibold">Temporary cover</h3>
          <button
            type="button"
            class="btn border-border-default ml-auto border"
            @click="showTemporary = !showTemporary"
          >
            {{ showTemporary ? 'Cancel' : 'Give someone temporary access' }}
          </button>
        </div>
        <p class="text-text-secondary mt-1 text-sm">
          For covering a shift. It ends by itself at the time you set, and the reason goes in the
          audit log.
        </p>

        <form v-if="showTemporary" class="mt-3 space-y-3" @submit.prevent="grantTemporary">
          <div>
            <label class="field-label" for="cover-user">Person</label>
            <select
              id="cover-user"
              v-model="draft.userId"
              class="field"
              :aria-invalid="guard.invalid('cover-user')"
              @change="guard.clear()"
            >
              <option value="">Choose someone</option>
              <option v-for="person in staff" :key="person.id" :value="person.id">
                {{ person.displayName }} ({{ roleLabels[person.role] }})
              </option>
            </select>
          </div>

          <div>
            <label class="field-label" for="cover-expiry">Ends at</label>
            <input
              id="cover-expiry"
              v-model="draft.expiresAt"
              class="field"
              type="datetime-local"
              :aria-invalid="guard.invalid('cover-expiry')"
              @input="guard.clear()"
            />
          </div>

          <div>
            <label class="field-label" for="cover-reason">Reason</label>
            <input
              id="cover-reason"
              v-model="draft.reason"
              class="field"
              type="text"
              placeholder="Covering tonight's shift"
              :aria-invalid="guard.invalid('cover-reason')"
              @input="guard.clear()"
            />
          </div>

          <button class="btn btn-primary" type="submit">Give temporary access</button>
        </form>

        <ul v-if="covering.length > 0" class="mt-3 space-y-2">
          <li
            v-for="assignment in assignments.filter(
              (one) => one.effective && one.kind === 'temporary',
            )"
            :key="assignment.id"
            class="border-border-default flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3"
          >
            <div class="min-w-0">
              <p class="font-medium">{{ assignment.userDisplayName }}</p>
              <p class="text-text-secondary text-sm">
                <span v-if="assignment.expiresAt">{{ timeRemaining(assignment.expiresAt) }}</span>
                <span v-if="assignment.reason"> · {{ assignment.reason }}</span>
              </p>
            </div>
            <button
              class="btn btn-destructive ml-auto min-h-11 px-3 text-sm"
              type="button"
              @click="revoke(assignment)"
            >
              End it now
            </button>
          </li>
        </ul>
      </div>

      <!-- Who had access and when is part of the record, so it stays visible. -->
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
