<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  canWriteCarePlans,
  describeCarePlanStatus,
  type CarePlan,
  type CarePlanVersion,
} from '@vigilo/shared';
import CarePlanBody from '@/components/CarePlanBody.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { markCarePlanRead, readCarePlans } from '@/lib/records';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';
import { formatDateTime } from '@/lib/format';
import { needsText, useFormGuard } from '@/lib/forms';

/**
 * The care plan section of the participant screen (doc 06 §4.7).
 *
 * A worker sees the published plan with its table of contents and an unread
 * marker. A nurse or admin also gets the draft editor, the version history and
 * who has read the current version.
 */
const props = defineProps<{ participantId: string }>();

const session = useSessionStore();
const offline = useOfflineStore();

const plans = ref<CarePlan[]>([]);
const selectedId = ref<string | null>(null);
const versions = ref<CarePlanVersion[]>([]);
const receipts = ref<{ userId: string; displayName: string; readAt: string }[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const creating = ref(false);
const newTitle = ref('');

const editing = ref<CarePlanVersion | null>(null);
const draftBody = ref('');
const publishing = ref(false);
const changeSummary = ref('');
const showHistory = ref(false);

const canWrite = computed(() => canWriteCarePlans(session.principal?.role ?? 'worker'));

const selected = computed(() => plans.value.find((one) => one.id === selectedId.value) ?? null);

const unreadCount = computed(() => plans.value.filter((one) => one.unread).length);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    plans.value = await readCarePlans(props.participantId);
    if (selectedId.value === null || !plans.value.some((one) => one.id === selectedId.value)) {
      selectedId.value = plans.value[0]?.id ?? null;
    }
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the care plans.';
  } finally {
    loading.value = false;
  }
}

/**
 * Showing a plan is what marks it read.
 *
 * Not a button somebody has to remember to press, and not only the chooser: a
 * participant usually has exactly one plan, so there is no chooser to click and
 * the marker would sit there for ever. It exists so a worker knows there is
 * something new, and it has done its job the moment they are looking at it.
 */
async function markShownAsRead(plan: CarePlan): Promise<void> {
  if (!plan.unread || plan.currentVersionId === null) return;

  try {
    await markCarePlanRead(plan);
    plans.value = plans.value.map((one) => (one.id === plan.id ? { ...one, unread: false } : one));
    void offline.sync();
  } catch {
    // A receipt that did not send is not worth an error on screen. The plan is
    // readable either way and the next sync picks it up.
  }
}

function open(plan: CarePlan): void {
  selectedId.value = plan.id;
  editing.value = null;
  showHistory.value = false;
}

async function create(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    const plan = await api.createCarePlan(props.participantId, {
      title: newTitle.value.trim(),
      body: '',
    });
    creating.value = false;
    newTitle.value = '';
    await load();
    selectedId.value = plan.id;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}

async function edit(): Promise<void> {
  if (selected.value === null) return;
  saving.value = true;
  error.value = '';
  try {
    const draft = await api.openCarePlanDraft(selected.value.id);
    editing.value = draft;
    draftBody.value = draft?.body ?? '';
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open the draft.';
  } finally {
    saving.value = false;
  }
}

async function saveDraft(): Promise<void> {
  if (editing.value === null) return;
  saving.value = true;
  error.value = '';
  try {
    await api.updateCarePlanDraft(editing.value.id, { body: draftBody.value });
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be saved.';
  } finally {
    saving.value = false;
  }
}

const guard = useFormGuard();

async function publish(): Promise<void> {
  if (editing.value === null) return;
  if (
    !guard.ready(
      needsText(
        'care-plan-change-summary',
        changeSummary.value,
        'Say what changed. It is what tells workers where to look.',
      ),
    )
  ) {
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await api.updateCarePlanDraft(editing.value.id, { body: draftBody.value });
    await api.publishCarePlanVersion(editing.value.id, {
      changeSummary: changeSummary.value.trim(),
    });
    editing.value = null;
    publishing.value = false;
    changeSummary.value = '';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be published.';
  } finally {
    saving.value = false;
  }
}

async function discard(): Promise<void> {
  if (editing.value === null) return;
  saving.value = true;
  try {
    await api.discardCarePlanDraft(editing.value.id);
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be discarded.';
  } finally {
    saving.value = false;
  }
}

async function loadHistory(): Promise<void> {
  if (selected.value === null) return;
  showHistory.value = !showHistory.value;
  if (!showHistory.value) return;
  try {
    versions.value = await api.listCarePlanVersions(selected.value.id);
    receipts.value = await api.listCarePlanReceipts(selected.value.id);
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the history.';
  }
}

onMounted(load);
watch(() => props.participantId, load);

// Whatever brought a plan on screen, the reader has now seen it.
watch(
  selected,
  (plan) => {
    if (plan !== null) void markShownAsRead(plan);
  },
  { immediate: true },
);
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Care plan</h2>
      <span v-if="unreadCount > 0" class="text-state-missed text-sm font-medium">
        {{ unreadCount }} not read yet
      </span>
      <button
        v-if="canWrite && !creating"
        type="button"
        class="btn border-border-default ml-auto border"
        @click="creating = true"
      >
        Add a plan
      </button>
    </div>

    <FormError :message="guard.problem.value?.message ?? error" />
    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <form v-if="creating" class="card space-y-3 p-4" @submit.prevent="create">
        <label>
          <span class="field-label">Title</span>
          <input v-model="newTitle" class="field" maxlength="160" required />
        </label>
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-primary" :disabled="saving">Create</button>
          <button
            type="button"
            class="btn border-border-default border"
            @click="
              creating = false;
              newTitle = '';
            "
          >
            Cancel
          </button>
        </div>
      </form>

      <p v-if="plans.length === 0" class="card text-text-secondary p-4">
        No care plan yet. A nurse or an admin writes one.
      </p>

      <!-- More than one plan is normal: standing instructions plus a seizure
           plan, for instance. One is the common case and needs no chooser. -->
      <nav v-if="plans.length > 1" class="flex flex-wrap gap-2">
        <button
          v-for="plan in plans"
          :key="plan.id"
          type="button"
          class="btn border-border-default border"
          :style="plan.id === selectedId ? { borderColor: 'var(--vigilo-primary)' } : {}"
          @click="open(plan)"
        >
          {{ plan.title }}
          <span v-if="plan.unread" class="text-state-missed ml-2">●</span>
        </button>
      </nav>

      <template v-if="selected">
        <article class="card space-y-3 p-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="text-lg font-semibold">{{ selected.title }}</h3>
            <span v-if="selected.unread" class="text-state-missed text-sm font-medium">
              New version, not read yet
            </span>
            <span class="text-text-secondary ml-auto text-sm">
              {{ describeCarePlanStatus(selected.status) }}
              <template v-if="selected.currentVersion !== null">
                · version {{ selected.currentVersion }}
              </template>
            </span>
          </div>

          <p v-if="selected.changeSummary" class="text-text-secondary text-sm">
            What changed: {{ selected.changeSummary }}
            <template v-if="selected.publishedAt">
              · published {{ formatDateTime(selected.publishedAt) }}
            </template>
          </p>

          <div v-if="editing === null">
            <p v-if="selected.body === null" class="text-text-secondary">
              Nothing has been published yet.
              <template v-if="selected.hasDraft && canWrite"> There is a draft waiting.</template>
            </p>
            <CarePlanBody v-else :body="selected.body" />
          </div>

          <!-- ------------------------------------------------- the editor -->
          <div v-else class="space-y-3">
            <div>
              <label class="field-label" for="care-plan-body">
                Draft, version {{ editing.version }}
              </label>
              <textarea
                id="care-plan-body"
                v-model="draftBody"
                class="field min-h-72 font-mono text-sm"
                :maxlength="50000"
              />
              <p class="text-text-secondary mt-1 text-sm">
                <code>## Heading</code>, <code>### Smaller heading</code>, <code>- bullet</code>,
                <code>1. step</code>, <code>**bold**</code>, <code>*italic*</code>. A blank line
                starts a new paragraph.
              </p>
            </div>

            <details class="card p-3">
              <summary class="min-h-11 cursor-pointer font-semibold">Preview</summary>
              <div class="mt-3">
                <CarePlanBody :body="draftBody" hide-contents />
              </div>
            </details>

            <div v-if="publishing" class="space-y-2">
              <label>
                <span class="field-label">What changed</span>
                <input
                  id="care-plan-change-summary"
                  v-model="changeSummary"
                  class="field"
                  maxlength="300"
                  placeholder="Added the seizure plan"
                  :aria-invalid="guard.invalid('care-plan-change-summary')"
                  @input="guard.clear()"
                />
              </label>
              <p class="text-text-secondary text-sm">
                Every assigned worker is told and shown an unread marker, so this is what tells them
                where to look.
              </p>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn border-border-default border"
                :disabled="saving"
                @click="saveDraft"
              >
                Save draft
              </button>
              <button
                v-if="!publishing"
                type="button"
                class="btn btn-primary"
                @click="publishing = true"
              >
                Publish
              </button>
              <button
                v-else
                type="button"
                class="btn btn-primary"
                :disabled="saving"
                @click="publish"
              >
                {{ saving ? 'Publishing' : 'Publish this version' }}
              </button>
              <button
                type="button"
                class="btn border-border-default border"
                @click="
                  editing = null;
                  publishing = false;
                "
              >
                Close
              </button>
              <button type="button" class="btn btn-destructive" :disabled="saving" @click="discard">
                Discard draft
              </button>
            </div>
          </div>

          <div v-if="canWrite" class="flex flex-wrap gap-2">
            <button
              v-if="editing === null"
              type="button"
              class="btn border-border-default border"
              :disabled="saving"
              @click="edit"
            >
              {{ selected.hasDraft ? 'Continue the draft' : 'Start a new version' }}
            </button>
            <button type="button" class="btn border-border-default border" @click="loadHistory">
              {{ showHistory ? 'Hide history' : 'History and who has read it' }}
            </button>
          </div>
        </article>

        <div v-if="showHistory" class="card space-y-4 p-4">
          <div>
            <h4 class="font-semibold">Versions</h4>
            <ul class="mt-2 space-y-1 text-sm">
              <li v-for="version in versions" :key="version.id">
                <span class="font-medium">Version {{ version.version }}</span>
                <span class="text-text-secondary ml-2">{{ version.status }}</span>
                <span v-if="version.publishedAt" class="text-text-secondary ml-2">
                  {{ formatDateTime(version.publishedAt) }}
                  <template v-if="version.publishedByName">
                    by {{ version.publishedByName }}
                  </template>
                </span>
                <span v-if="version.changeSummary" class="text-text-secondary ml-2">
                  · {{ version.changeSummary }}
                </span>
              </li>
            </ul>
          </div>

          <div>
            <h4 class="font-semibold">Read by</h4>
            <p v-if="receipts.length === 0" class="text-text-secondary mt-1 text-sm">
              Nobody has opened this version yet.
            </p>
            <ul v-else class="mt-2 space-y-1 text-sm">
              <li v-for="receipt in receipts" :key="receipt.userId">
                {{ receipt.displayName }}
                <span class="text-text-secondary ml-2">{{ formatDateTime(receipt.readAt) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>
