<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  actionIsOverdue,
  canCloseIncident,
  describeIncidentStatus,
  describeSeverity,
  incidentSeverities,
  incidentSortRank,
  outstandingActions,
  type Incident,
  type IncidentSeverity,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError, type Colleague } from '@/api/client';
import { readColleagues } from '@/lib/records';
import { useSessionStore } from '@/stores/session';
import { uuidv7 } from '@/lib/uuid';
import { formatDateTimeIn } from '@/lib/format';
import { needsText, useFormGuard } from '@/lib/forms';

/**
 * The incident section of the participant screen (doc 01 §7.3).
 *
 * Online only. Incidents are deliberately not held on a device (D67): raising
 * one needs the detail a person types sitting down afterwards, and the
 * narrative is the most sensitive text in the product to leave on a phone.
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();

const incidents = ref<Incident[]>([]);
const timeZone = ref(session.timeZone);
const colleagues = ref<Colleague[]>([]);
const statusFilter = ref<'' | 'open' | 'under_review' | 'closed'>('');
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const raising = ref(false);
const openId = ref<string | null>(null);
const closingId = ref<string | null>(null);
const closureNotes = ref('');
const actionText = ref('');
const actionAssignee = ref('');
const actionDue = ref('');

const canClose = computed(() => canCloseIncident(session.principal?.role ?? 'worker'));

const ordered = computed(() =>
  [...incidents.value].sort(
    (a, b) =>
      incidentSortRank(a) - incidentSortRank(b) ||
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  ),
);

function blankForm() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  return {
    occurredAt: local,
    discoveredAt: local,
    severity: 'moderate' as IncidentSeverity,
    summary: '',
    detail: '',
    immediateAction: '',
    injuries: '',
    involved: '',
    familyNotifiedAt: '',
  };
}

const form = ref(blankForm());

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const response = await api.listIncidents(
      props.participantId,
      statusFilter.value === '' ? {} : { status: statusFilter.value },
    );
    incidents.value = response.incidents;
    timeZone.value = response.timeZone;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load incidents.';
  } finally {
    loading.value = false;
  }
}

/** A local `datetime-local` value as an instant. */
function instant(local: string): string {
  return new Date(local).toISOString();
}

async function raise(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await api.createIncident(props.participantId, {
      id: uuidv7(),
      occurredAt: instant(form.value.occurredAt),
      discoveredAt: instant(form.value.discoveredAt),
      severity: form.value.severity,
      summary: form.value.summary.trim(),
      detail: form.value.detail.trim(),
      immediateAction: form.value.immediateAction.trim(),
      injuries: form.value.injuries.trim() === '' ? null : form.value.injuries.trim(),
      involved: form.value.involved.trim() === '' ? null : form.value.involved.trim(),
      familyNotifiedAt:
        form.value.familyNotifiedAt === '' ? null : instant(form.value.familyNotifiedAt),
    });
    raising.value = false;
    form.value = blankForm();
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}

const guard = useFormGuard();

async function close(id: string): Promise<void> {
  if (
    !guard.ready(
      needsText(
        'incident-closure-notes',
        closureNotes.value,
        'Say how this incident was resolved.',
      ),
    )
  ) {
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await api.closeIncident(id, { closureNotes: closureNotes.value.trim() });
    closingId.value = null;
    closureNotes.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be closed.';
  } finally {
    saving.value = false;
  }
}

async function addAction(id: string): Promise<void> {
  if (!guard.ready(needsText('incident-action', actionText.value, 'Write the action first.'))) {
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await api.addIncidentAction(id, {
      id: uuidv7(),
      action: actionText.value.trim(),
      assignedTo: actionAssignee.value === '' ? null : actionAssignee.value,
      dueAt: actionDue.value === '' ? null : instant(actionDue.value),
    });
    actionText.value = '';
    actionAssignee.value = '';
    actionDue.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be added.';
  } finally {
    saving.value = false;
  }
}

async function completeAction(actionId: string): Promise<void> {
  saving.value = true;
  try {
    await api.completeIncidentAction(actionId, { note: null });
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be completed.';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    colleagues.value = await readColleagues();
  } catch {
    // An unassigned action is still a useful action.
  }
});

watch(() => props.participantId, load);
watch(statusFilter, load);

const now = new Date();
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Incidents</h2>
      <select v-model="statusFilter" class="field max-w-44" aria-label="Filter by status">
        <option value="">All</option>
        <option value="open">Open</option>
        <option value="under_review">Under review</option>
        <option value="closed">Closed</option>
      </select>
      <button v-if="!raising" type="button" class="btn btn-primary ml-auto" @click="raising = true">
        Raise an incident
      </button>
    </div>

    <p class="text-text-secondary text-sm">
      Incidents need a connection. They are not kept on the phone, and the NDIS Commission
      reportable-incident process is handled outside Vigilo.
    </p>

    <FormError :message="guard.problem.value?.message ?? error" />

    <!-- ---------------------------------------------------------- raising -->
    <form v-if="raising" class="card space-y-4 p-4" @submit.prevent="raise">
      <h3 class="text-lg font-semibold">What happened</h3>

      <div class="grid gap-4 sm:grid-cols-2">
        <label>
          <span class="field-label">When it happened</span>
          <input v-model="form.occurredAt" type="datetime-local" class="field" required />
        </label>
        <label>
          <span class="field-label">When it was found</span>
          <input v-model="form.discoveredAt" type="datetime-local" class="field" required />
        </label>
      </div>

      <fieldset>
        <legend class="field-label">Severity</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="one in incidentSeverities"
            :key="one"
            class="border-border-default flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3"
            :style="form.severity === one ? { borderColor: 'var(--vigilo-primary)' } : {}"
          >
            <input v-model="form.severity" type="radio" :value="one" name="severity" />
            <span>{{ describeSeverity(one) }}</span>
          </label>
        </div>
      </fieldset>

      <label>
        <span class="field-label">In one line</span>
        <input v-model="form.summary" class="field" maxlength="300" required />
      </label>

      <label>
        <span class="field-label">What happened</span>
        <textarea v-model="form.detail" rows="4" class="field" maxlength="10000" required />
      </label>

      <label>
        <span class="field-label">What was done straight away</span>
        <textarea
          v-model="form.immediateAction"
          rows="3"
          class="field"
          maxlength="10000"
          required
        />
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label>
          <span class="field-label">Injuries (optional)</span>
          <textarea v-model="form.injuries" rows="2" class="field" maxlength="5000" />
        </label>
        <label>
          <span class="field-label">Who was involved (optional)</span>
          <textarea v-model="form.involved" rows="2" class="field" maxlength="1000" />
        </label>
      </div>

      <label>
        <span class="field-label">Family notified (optional)</span>
        <input v-model="form.familyNotifiedAt" type="datetime-local" class="field max-w-72" />
      </label>

      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn btn-primary" :disabled="saving">
          {{ saving ? 'Saving' : 'Raise it' }}
        </button>
        <button
          type="button"
          class="btn border-border-default border"
          @click="
            raising = false;
            form = blankForm();
          "
        >
          Cancel
        </button>
      </div>
    </form>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <!--
      Only when the list really is empty. Saying "nothing recorded" under a
      failed request reads as "there are no incidents", which is the opposite
      of what happened.
    -->
    <p v-else-if="ordered.length === 0 && error === ''" class="card text-text-secondary p-4">
      Nothing recorded.
    </p>

    <!-- ------------------------------------------------------------- list -->
    <article v-for="incident in ordered" :key="incident.id" class="card space-y-2 p-4">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p class="font-semibold">{{ incident.summary }}</p>
        <span class="text-text-secondary text-sm">
          {{ describeIncidentStatus(incident.status) }} ·
          {{ describeSeverity(incident.severity) }} severity
        </span>
        <span class="text-text-secondary tabular ml-auto text-sm">
          {{ formatDateTimeIn(incident.occurredAt, timeZone) }}
        </span>
      </div>

      <p v-if="outstandingActions(incident.actions) > 0" class="text-state-missed text-sm">
        {{ outstandingActions(incident.actions) }} follow-up
        {{ outstandingActions(incident.actions) === 1 ? 'action' : 'actions' }} outstanding
      </p>

      <button
        type="button"
        class="btn border-border-default border"
        @click="openId = openId === incident.id ? null : incident.id"
      >
        {{ openId === incident.id ? 'Hide' : 'Open' }}
      </button>

      <div v-if="openId === incident.id" class="space-y-3 pt-2">
        <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt class="text-text-secondary text-sm">Found</dt>
            <dd class="tabular">{{ formatDateTimeIn(incident.discoveredAt, timeZone) }}</dd>
          </div>
          <div>
            <dt class="text-text-secondary text-sm">Reported by</dt>
            <dd>{{ incident.reportedByName ?? 'Not recorded' }}</dd>
          </div>
          <div v-if="incident.familyNotifiedAt">
            <dt class="text-text-secondary text-sm">Family notified</dt>
            <dd class="tabular">{{ formatDateTimeIn(incident.familyNotifiedAt, timeZone) }}</dd>
          </div>
        </dl>

        <div>
          <p class="field-label">What happened</p>
          <p class="whitespace-pre-wrap">{{ incident.detail }}</p>
        </div>

        <div>
          <p class="field-label">What was done straight away</p>
          <p class="whitespace-pre-wrap">{{ incident.immediateAction }}</p>
        </div>

        <div v-if="incident.injuries">
          <p class="field-label">Injuries</p>
          <p class="whitespace-pre-wrap">{{ incident.injuries }}</p>
        </div>

        <div v-if="incident.involved">
          <p class="field-label">Who was involved</p>
          <p class="whitespace-pre-wrap">{{ incident.involved }}</p>
        </div>

        <!-- ------------------------------------------------- follow-up -->
        <div class="space-y-2">
          <p class="field-label">Follow-up</p>
          <ul v-if="incident.actions.length > 0" class="space-y-2">
            <li v-for="action in incident.actions" :key="action.id" class="text-sm">
              <span :class="action.completedAt ? 'line-through opacity-70' : ''">
                {{ action.action }}
              </span>
              <span class="text-text-secondary ml-2">
                {{ action.assignedToName ? `for ${action.assignedToName}` : 'unassigned' }}
                <template v-if="action.dueAt">
                  · due {{ formatDateTimeIn(action.dueAt, timeZone) }}
                </template>
              </span>
              <span v-if="actionIsOverdue(action, now)" class="text-state-missed ml-2"
                >overdue</span
              >
              <span v-if="action.completedAt" class="text-text-secondary ml-2">
                · done by {{ action.completedByName ?? 'somebody' }}
              </span>
              <button
                v-else
                type="button"
                class="btn border-border-default ml-2 border"
                :disabled="saving"
                @click="completeAction(action.id)"
              >
                Mark done
              </button>
            </li>
          </ul>

          <div class="flex flex-wrap items-end gap-2">
            <label class="min-w-52 grow">
              <span class="field-label">Add a follow-up action</span>
              <input
                id="incident-action"
                v-model="actionText"
                class="field"
                maxlength="2000"
                :aria-invalid="guard.invalid('incident-action')"
                @input="guard.clear()"
              />
            </label>
            <label class="min-w-44">
              <span class="field-label">For</span>
              <select v-model="actionAssignee" class="field">
                <option value="">Nobody yet</option>
                <option v-for="one in colleagues" :key="one.id" :value="one.id">
                  {{ one.displayName }}
                </option>
              </select>
            </label>
            <label class="min-w-44">
              <span class="field-label">Due</span>
              <input v-model="actionDue" type="datetime-local" class="field" />
            </label>
            <button
              type="button"
              class="btn border-border-default border"
              :disabled="saving"
              @click="addAction(incident.id)"
            >
              Add
            </button>
          </div>
        </div>

        <!-- ---------------------------------------------------- closure -->
        <div v-if="incident.status === 'closed'" class="space-y-1">
          <p class="field-label">Closure</p>
          <p class="text-text-secondary text-sm">
            Closed {{ incident.closedAt ? formatDateTimeIn(incident.closedAt, timeZone) : '' }}
            <template v-if="incident.closedByName"> by {{ incident.closedByName }}</template>
          </p>
          <p v-if="incident.closureNotes" class="whitespace-pre-wrap">
            {{ incident.closureNotes }}
          </p>
        </div>

        <div v-else-if="canClose" class="space-y-2">
          <template v-if="closingId === incident.id">
            <label>
              <span class="field-label">Closure notes</span>
              <textarea
                id="incident-closure-notes"
                v-model="closureNotes"
                rows="3"
                class="field"
                maxlength="10000"
                :aria-invalid="guard.invalid('incident-closure-notes')"
                @input="guard.clear()"
              />
              <span class="text-text-secondary block text-sm">
                A closure nobody can read the reasoning for is a closure nobody can review.
              </span>
            </label>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn btn-primary"
                :disabled="saving"
                @click="close(incident.id)"
              >
                Close it
              </button>
              <button
                type="button"
                class="btn border-border-default border"
                @click="
                  closingId = null;
                  closureNotes = '';
                "
              >
                Cancel
              </button>
            </div>
          </template>
          <button
            v-else
            type="button"
            class="btn border-border-default border"
            @click="closingId = incident.id"
          >
            Close this incident
          </button>
        </div>

        <a
          :href="api.incidentPdfUrl(incident.id)"
          class="btn border-border-default inline-flex border"
          target="_blank"
          rel="noopener"
        >
          Download the PDF
        </a>
      </div>
    </article>
  </section>
</template>
