<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  participantDisplayName,
  templateSchemaSchema,
  validateValues,
  type CheckValue,
  type ParticipantSummary,
  type TemplateSchema,
} from '@vigilo/shared';
import DynamicForm from '@/components/DynamicForm.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { readParticipant, recordUnscheduledCheck } from '@/lib/records';
import { needs, needsChoice, useFormGuard } from '@/lib/forms';
import { uuidv7 } from '@/lib/uuid';

/**
 * Recording a check nobody scheduled (D89).
 *
 * Pick a form, fill it in, save. This is the screen that answers "somebody
 * asked me to take a blood pressure and there is nowhere to put it": until now
 * every check hung off a window an admin had scheduled in advance.
 *
 * It is not the Today screen and it is not a window. There is no countdown, no
 * status and no lateness, because nothing asked for this at any particular
 * time.
 */
const route = useRoute();
const router = useRouter();

const participantId = computed(() => String(route.params.id ?? ''));

const participant = ref<ParticipantSummary | null>(null);
const forms = ref<{ id: string; name: string; description: string | null }[]>([]);
const templateId = ref('');
const values = ref<Record<string, CheckValue>>({});
const loading = ref(true);
const saving = ref(false);
const error = ref('');

const guard = useFormGuard();

const chosen = computed(() => forms.value.find((form) => form.id === templateId.value) ?? null);

/**
 * The schema is fetched with the form list rather than held here, so the
 * preview a worker fills in is the published version the server will bind the
 * entry to.
 */
const schemas = ref<Record<string, TemplateSchema>>({});
const schema = computed<TemplateSchema>(() => schemas.value[templateId.value] ?? { fields: [] });

const problems = computed(() => validateValues(schema.value, Object.values(values.value)));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [detail, list] = await Promise.all([
      readParticipant(participantId.value),
      api.listRecordableForms(participantId.value),
    ]);
    participant.value = detail.participant;
    forms.value = list;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open that screen.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function chooseForm(id: string): Promise<void> {
  templateId.value = id;
  values.value = {};
  guard.clear();
  if (id === '' || schemas.value[id]) return;

  try {
    const template = await api.getTemplate(id);
    const parsed = templateSchemaSchema.safeParse(template.publishedVersion?.schema);
    schemas.value = { ...schemas.value, [id]: parsed.success ? parsed.data : { fields: [] } };
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not open that form.';
  }
}

function onChange(value: CheckValue): void {
  values.value = { ...values.value, [value.fieldKey]: value };
  guard.clear();
}

async function save(): Promise<void> {
  const filled = Object.values(values.value);
  if (
    saving.value ||
    !guard.ready(
      needsChoice('recordable-form', templateId.value, 'Choose which form you are filling in.'),
      needs('check-form', problems.value.length === 0, problems.value[0]?.message ?? ''),
      needs('check-form', filled.length > 0, 'Nothing has been filled in yet.'),
    )
  ) {
    return;
  }

  saving.value = true;
  error.value = '';
  try {
    await recordUnscheduledCheck({
      participantId: participantId.value,
      request: {
        entryId: uuidv7(),
        templateId: templateId.value,
        recordedAt: new Date().toISOString(),
        values: filled,
      },
    });
    // The sync indicator in the shell already says when something is waiting
    // to send, so there is nothing to add here beyond going back.
    await router.push({ name: 'participant', params: { id: participantId.value } });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not save that.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <RouterLink :to="{ name: 'participant', params: { id: participantId } }" class="text-primary">
        ← {{ participant ? participantDisplayName(participant) : 'Participant' }}
      </RouterLink>
      <h1 class="text-2xl font-semibold">Record a check</h1>
    </div>

    <p class="text-text-secondary">
      For something nobody put on the schedule. It is recorded at the time you save it, and it is
      never counted as a scheduled check that was done or missed.
    </p>

    <FormError :message="guard.problem.value?.message ?? error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else-if="forms.length === 0">
      <div class="card p-6">
        <p class="font-medium">There are no published check forms yet.</p>
        <p class="text-text-secondary mt-1">
          An admin or a nurse creates one under Check forms and publishes it, then it appears here.
        </p>
      </div>
    </template>

    <template v-else>
      <div class="card p-4">
        <label class="field-label" for="recordable-form">Which form</label>
        <select
          id="recordable-form"
          class="field"
          :value="templateId"
          :aria-invalid="guard.invalid('recordable-form')"
          @change="chooseForm(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Choose a form…</option>
          <option v-for="form in forms" :key="form.id" :value="form.id">{{ form.name }}</option>
        </select>
        <p v-if="chosen?.description" class="text-text-secondary mt-1 text-sm">
          {{ chosen.description }}
        </p>
      </div>

      <!-- `tabindex` so a save that complains can put focus back on the form. -->
      <section v-if="templateId" id="check-form" class="card p-4" tabindex="-1">
        <DynamicForm :schema="schema" :values="values" @change="onChange" />
      </section>

      <!--
        Always here, even before a form is chosen (D78). Hiding it would be the
        greyed-out button by another route: the worker presses nothing and
        learns nothing. Pressing it says to choose a form and points at the
        picker.
      -->
      <div class="card flex flex-wrap items-center gap-3 p-4">
        <p class="text-text-secondary text-sm">
          {{
            chosen
              ? `Saved against ${chosen.name}, at the time you press save.`
              : 'Choose a form above, fill it in, then save.'
          }}
        </p>
        <button type="button" class="btn btn-primary ml-auto" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save this check' }}
        </button>
      </div>
    </template>
  </div>
</template>
