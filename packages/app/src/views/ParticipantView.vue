<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  canEditAlerts,
  canEditContacts,
  canGrantAccess,
  canManageParticipants,
  canWriteEmergencyPlan,
  participantDisplayName,
  type ParticipantDetail,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import ParticipantAlerts from '@/components/ParticipantAlerts.vue';
import EmergencyContacts from '@/components/EmergencyContacts.vue';
import EmergencyPlanPanel from '@/components/EmergencyPlanPanel.vue';
import ParticipantAssignments from '@/components/ParticipantAssignments.vue';
import ParticipantChecks from '@/components/ParticipantChecks.vue';
import ParticipantDiary from '@/components/ParticipantDiary.vue';
import ParticipantMedications from '@/components/ParticipantMedications.vue';
import ParticipantCarePlans from '@/components/ParticipantCarePlans.vue';
import ParticipantIncidents from '@/components/ParticipantIncidents.vue';
import ParticipantTimeline from '@/components/ParticipantTimeline.vue';
import * as api from '@/api/client';
import { readParticipant } from '@/lib/records';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { ageInYears, formatDate, timeRemaining } from '@/lib/format';

/**
 * The participant overview (doc 06 §4.2).
 *
 * Alerts sit above everything and stay visible on every tab, because an
 * allergy is not something a person should have to change tabs to find. The
 * timeline is the default: what happened to this person, in order, which is
 * how a shift is actually handed over.
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''));

const participant = ref<ParticipantDetail | null>(null);
const loading = ref(true);
/** True when this came from the device, which holds no administrative detail. */
const partial = ref(false);
const error = ref('');
const confirmingArchive = ref(false);

const tabs = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'checks', label: 'Checks' },
  { key: 'medication', label: 'Medication' },
  { key: 'care-plan', label: 'Care plan' },
  { key: 'diary', label: 'Diary' },
  { key: 'incidents', label: 'Incidents' },
  { key: 'info', label: 'Info' },
] as const;

const tab = ref<(typeof tabs)[number]['key']>('timeline');

const role = computed(() => session.principal?.role ?? 'worker');
const canManage = computed(() => canManageParticipants(role.value));

async function load(): Promise<void> {
  error.value = '';
  try {
    const result = await readParticipant(id.value);
    participant.value = result.participant;
    partial.value = result.partial;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load that record.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function archive(): Promise<void> {
  error.value = '';
  try {
    await api.archiveParticipant(id.value);
    confirmingArchive.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not archive that record.';
  }
}

async function restore(): Promise<void> {
  error.value = '';
  try {
    await api.restoreParticipant(id.value);
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not restore that record.';
  }
}
</script>

<template>
  <div class="space-y-6">
    <button
      class="text-text-secondary min-h-11 text-sm underline"
      type="button"
      @click="router.back()"
    >
      Back
    </button>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else-if="participant">
      <header class="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold">{{ participantDisplayName(participant) }}</h1>
          <p v-if="participant.preferredName" class="text-text-secondary">
            {{ participant.firstName }} {{ participant.lastName }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-sm">
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
            Your access is temporary, {{ timeRemaining(participant.access.expiresAt) }}
          </span>
        </div>

        <div v-if="canManage" class="ml-auto flex flex-wrap gap-2 text-sm">
          <RouterLink
            class="btn border-border-default min-h-11 border px-3"
            :to="{ name: 'participant-edit', params: { id: participant.id } }"
          >
            Edit details
          </RouterLink>

          <button
            v-if="participant.status === 'active' && !confirmingArchive"
            class="btn btn-destructive min-h-11 px-3"
            type="button"
            @click="confirmingArchive = true"
          >
            Archive
          </button>
          <template v-else-if="participant.status === 'active'">
            <button class="btn btn-destructive min-h-11 px-3" type="button" @click="archive">
              Yes, archive
            </button>
            <button
              class="btn border-border-default min-h-11 border px-3"
              type="button"
              @click="confirmingArchive = false"
            >
              Cancel
            </button>
          </template>
          <button
            v-else
            class="btn border-border-default min-h-11 border px-3"
            type="button"
            @click="restore"
          >
            Bring back
          </button>
        </div>
      </header>

      <p v-if="confirmingArchive" class="text-text-secondary text-sm">
        Archiving hides this person from the list. Nothing is deleted, and you can bring the record
        back.
      </p>

      <ParticipantAlerts
        :participant-id="participant.id"
        :alerts="participant.alerts"
        :can-edit="canEditAlerts(role)"
        @changed="load"
      />

      <!-- Doc 06 §4.2. Alerts are above this and stay on every tab. -->
      <nav
        class="border-border-default flex flex-wrap gap-1 border-b"
        aria-label="Participant sections"
      >
        <button
          v-for="one in tabs"
          :key="one.key"
          type="button"
          class="min-h-11 border-b-2 px-3 font-medium"
          :style="
            tab === one.key
              ? { borderColor: 'var(--vigilo-primary)', color: 'var(--vigilo-primary)' }
              : { borderColor: 'transparent' }
          "
          :aria-current="tab === one.key ? 'page' : undefined"
          @click="tab = one.key"
        >
          {{ one.label }}
        </button>
      </nav>

      <ParticipantTimeline v-if="tab === 'timeline'" :participant-id="participant.id" />

      <ParticipantChecks v-else-if="tab === 'checks'" :participant-id="participant.id" />

      <ParticipantMedications v-else-if="tab === 'medication'" :participant-id="participant.id" />

      <ParticipantCarePlans v-else-if="tab === 'care-plan'" :participant-id="participant.id" />

      <ParticipantIncidents v-else-if="tab === 'incidents'" :participant-id="participant.id" />

      <ParticipantDiary
        v-else-if="tab === 'diary'"
        :participant-id="participant.id"
        :participant-name="participant.preferredName ?? participant.firstName"
      />

      <template v-else>
        <section class="space-y-3">
          <h2 class="text-lg font-semibold">Details</h2>

          <!--
            Said plainly rather than shown as convincing blanks. The device
            never holds the administrative detail, only what the work needs.
          -->
          <p v-if="partial" class="card text-text-secondary p-4">
            These need a connection. Alerts, emergency contacts and the care plan are on this device
            and are shown above.
          </p>

          <dl v-else class="card grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
            <div>
              <dt class="text-text-secondary text-sm">Date of birth</dt>
              <dd class="tabular">
                {{ formatDate(participant.dateOfBirth) }}
                <span class="text-text-secondary">({{ ageInYears(participant.dateOfBirth) }})</span>
              </dd>
            </div>
            <div>
              <dt class="text-text-secondary text-sm">NDIS number</dt>
              <dd class="tabular">{{ participant.ndisNumber }}</dd>
            </div>
            <div>
              <dt class="text-text-secondary text-sm">Phone</dt>
              <dd>
                <a v-if="participant.phone" class="underline" :href="`tel:${participant.phone}`">
                  {{ participant.phone }}
                </a>
                <span v-else class="text-text-secondary">Not recorded</span>
              </dd>
            </div>
            <div>
              <dt class="text-text-secondary text-sm">Email</dt>
              <dd class="break-all">
                {{ participant.email ?? 'Not recorded' }}
              </dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-text-secondary text-sm">Address</dt>
              <dd class="whitespace-pre-wrap">{{ participant.address ?? 'Not recorded' }}</dd>
            </div>
            <div v-if="participant.notes" class="sm:col-span-2">
              <dt class="text-text-secondary text-sm">Admin notes</dt>
              <dd class="whitespace-pre-wrap">{{ participant.notes }}</dd>
            </div>
          </dl>
        </section>

        <EmergencyContacts
          :participant-id="participant.id"
          :contacts="participant.contacts"
          :can-edit="canEditContacts(role)"
          @changed="load"
        />

        <EmergencyPlanPanel
          :participant-id="participant.id"
          :plan="participant.emergencyPlan"
          :can-edit="canWriteEmergencyPlan(role)"
          @changed="load"
        />

        <ParticipantAssignments v-if="canGrantAccess(role)" :participant-id="participant.id" />
      </template>
    </template>
  </div>
</template>
