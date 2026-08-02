<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  addDays,
  localDateOf,
  participantShortName,
  type ComplianceGrouping,
  type ComplianceReport,
  type ExportJob,
  type ExportKind,
  type ParticipantSummary,
  type TrendBucket,
  type TrendSeries,
} from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import TrendChart from '@/components/TrendChart.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { needsChoice, useFormGuard } from '@/lib/forms';

/**
 * Reports (doc 06 §5).
 *
 * Four tools on one screen: the daily PDF, the trend explorer, the compliance
 * report and the CSV export. They share a participant and a date range because
 * that is how somebody actually uses them: they pick a person and a period,
 * then look at it three ways.
 */
const session = useSessionStore();

const timeZone = computed(() => session.timeZone);
const today = computed(() => localDateOf(new Date(), timeZone.value));

const tab = ref<'daily' | 'trends' | 'compliance' | 'export'>('compliance');

const participants = ref<ParticipantSummary[]>([]);
const participantId = ref('');
const from = ref('');
const to = ref('');

const error = ref('');
const busy = ref(false);

const compliance = ref<ComplianceReport | null>(null);
const groupBy = ref<ComplianceGrouping>('participant');

const trendFields = ref<api.TrendField[]>([]);
const fieldKey = ref('');
const bucket = ref<TrendBucket>('none');
const series = ref<TrendSeries | null>(null);

const exportKind = ref<ExportKind>('checks');
const exportJobs = ref<ExportJob[]>([]);
const exportMessage = ref('');

const names = computed(
  () => new Map(participants.value.map((one) => [one.id, participantShortName(one)])),
);

const isAdmin = computed(() => session.principal?.role === 'admin');

function exportKindLabel(kind: string): string {
  if (kind === 'checks') return 'Check entries';
  if (kind === 'medications') return 'Medication sign-offs';
  return 'Diary entries';
}

onMounted(async () => {
  from.value = addDays(today.value, -6);
  to.value = today.value;

  try {
    participants.value = await api.listParticipants();
    await loadCompliance();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load reports.';
  }
});

/* ---------------------------------------------------------- compliance */

async function loadCompliance(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    compliance.value = await api.getComplianceReport({
      from: from.value,
      to: to.value,
      groupBy: groupBy.value,
      ...(participantId.value === '' ? {} : { participantId: participantId.value }),
    });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not run that report.';
  } finally {
    busy.value = false;
  }
}

/* -------------------------------------------------------------- trends */

watch(participantId, async (id) => {
  series.value = null;
  fieldKey.value = '';
  trendFields.value = [];
  if (id === '') return;

  try {
    trendFields.value = await api.listTrendFields(id);
    fieldKey.value = trendFields.value[0]?.fieldKey ?? '';
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the fields.';
  }
});

const guard = useFormGuard();

async function loadTrend(): Promise<void> {
  if (participantId.value === '') return;
  if (!guard.ready(needsChoice('trend-field', fieldKey.value, 'Choose a reading to chart.'))) {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    series.value = await api.getTrend({
      participantId: participantId.value,
      fieldKey: fieldKey.value,
      from: from.value,
      to: to.value,
      bucket: bucket.value,
    });
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load that trend.';
  } finally {
    busy.value = false;
  }
}

/* --------------------------------------------------------------- daily */

const pdfUrl = computed(() =>
  participantId.value === ''
    ? ''
    : api.dailyReportPdfUrl(participantId.value, from.value, to.value),
);

/* -------------------------------------------------------------- export */

async function runExport(): Promise<void> {
  busy.value = true;
  error.value = '';
  exportMessage.value = '';
  try {
    const result = await api.requestExport({
      kind: exportKind.value,
      from: from.value,
      to: to.value,
      ...(participantId.value === '' ? {} : { participantId: participantId.value }),
    });

    if (result.kind === 'file') {
      download(result.blob, result.filename);
      exportMessage.value = 'Downloaded.';
      return;
    }

    // Too big to hand back on the request, so it is being built. Doc 01 §8.4.
    exportMessage.value =
      'That is a large export, so it is being prepared. It will appear below when it is ready.';
    await loadExportJobs();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not make that export.';
  } finally {
    busy.value = false;
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function loadExportJobs(): Promise<void> {
  if (!isAdmin.value) return;
  try {
    exportJobs.value = await api.listExportJobs();
  } catch {
    // The list is a convenience. A failure here should not take the screen
    // down when the export itself may have worked.
  }
}

watch(tab, (value) => {
  if (value === 'export') void loadExportJobs();
});

function describeJob(job: ExportJob): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting to start';
    case 'running':
      return 'Being prepared';
    case 'ready':
      return `${job.rowCount ?? 0} rows, ready`;
    case 'failed':
      return job.error ?? 'Something went wrong';
  }
}
</script>

<template>
  <div class="space-y-5">
    <h1 class="text-2xl font-semibold">Reports</h1>

    <FormError :message="guard.problem.value?.message ?? error" />

    <!-- One participant and one period, shared by all four tools. -->
    <div class="card flex flex-wrap items-end gap-3 p-4">
      <div class="min-w-52 flex-1">
        <label class="field-label" for="report-participant">Participant</label>
        <select id="report-participant" v-model="participantId" class="field">
          <option value="">Everyone I can see</option>
          <option v-for="one in participants" :key="one.id" :value="one.id">
            {{ names.get(one.id) }}
          </option>
        </select>
      </div>
      <div>
        <label class="field-label" for="report-from">From</label>
        <input id="report-from" v-model="from" type="date" class="field" :max="to" />
      </div>
      <div>
        <label class="field-label" for="report-to">To</label>
        <input id="report-to" v-model="to" type="date" class="field" :min="from" :max="today" />
      </div>
    </div>

    <nav class="border-border-default flex flex-wrap gap-1 border-b" aria-label="Reports">
      <button
        v-for="option in [
          { key: 'compliance', label: 'Compliance' },
          { key: 'daily', label: 'Daily report' },
          { key: 'trends', label: 'Trends' },
          { key: 'export', label: 'Export' },
        ]"
        :key="option.key"
        type="button"
        class="min-h-11 px-3 text-base"
        :class="
          tab === option.key
            ? 'border-primary text-primary border-b-2 font-semibold'
            : 'text-text-secondary'
        "
        :aria-current="tab === option.key ? 'page' : undefined"
        @click="tab = option.key as typeof tab"
      >
        {{ option.label }}
      </button>
    </nav>

    <!-- ------------------------------------------------------ compliance -->
    <section v-if="tab === 'compliance'" class="space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-40">
          <label class="field-label" for="group-by">Group by</label>
          <select id="group-by" v-model="groupBy" class="field" @change="loadCompliance">
            <option value="participant">Participant</option>
            <option value="worker">Worker</option>
            <option value="day">Day</option>
          </select>
        </div>
        <button type="button" class="btn btn-primary" :disabled="busy" @click="loadCompliance">
          {{ busy ? 'Running' : 'Run report' }}
        </button>
      </div>

      <div v-if="compliance" class="space-y-3">
        <div class="card space-y-1 p-4">
          <p class="text-2xl font-semibold tabular">
            {{
              compliance.totalPercent === null
                ? 'No checks scheduled'
                : `${compliance.totalPercent}%`
            }}
          </p>
          <p class="text-text-secondary text-sm">
            {{ compliance.total.completed }} of {{ compliance.total.expected }} scheduled checks
            completed, {{ compliance.from }} to {{ compliance.to }}.
          </p>
          <p v-if="compliance.total.pending > 0" class="text-text-secondary text-sm">
            {{ compliance.total.pending }} are still open and counted as scheduled, so the
            percentage will move as they are recorded.
          </p>
          <!--
            Stated rather than left to be worked out. A period with a lot of
            family cover is not a period with a lot of missed checks
            (doc 01 §5.6).
          -->
          <p v-if="compliance.total.notExpected > 0" class="text-text-secondary text-sm">
            {{ compliance.total.notExpected }} windows were not scheduled and are not counted.
          </p>
        </div>

        <div class="card overflow-x-auto p-0">
          <table class="w-full min-w-[46rem] text-sm">
            <thead>
              <tr class="border-border-default text-text-secondary border-b text-left">
                <th class="p-3 font-semibold">
                  {{
                    compliance.groupBy === 'participant'
                      ? 'Participant'
                      : compliance.groupBy === 'worker'
                        ? 'Worker'
                        : 'Day'
                  }}
                </th>
                <th class="p-3 text-right font-semibold">Scheduled</th>
                <th class="p-3 text-right font-semibold">Completed</th>
                <th class="p-3 text-right font-semibold">Late</th>
                <th class="p-3 text-right font-semibold">Partial</th>
                <th class="p-3 text-right font-semibold">Missed, reason</th>
                <th class="p-3 text-right font-semibold">Missed, none</th>
                <!--
                  Still open is its own column so the row adds up. A table
                  where the parts do not sum to the total is a table somebody
                  will not trust, and this one gets read by auditors.
                -->
                <th class="p-3 text-right font-semibold">Still open</th>
                <th class="p-3 text-right font-semibold">Not scheduled</th>
                <th class="p-3 text-right font-semibold">Completion</th>
              </tr>
            </thead>
            <tbody class="tabular">
              <tr
                v-for="row in compliance.rows"
                :key="row.key"
                class="border-border-default border-b"
              >
                <td class="p-3">{{ row.label }}</td>
                <td class="p-3 text-right">{{ row.counts.expected }}</td>
                <td class="p-3 text-right">{{ row.counts.completed }}</td>
                <td class="p-3 text-right">{{ row.counts.completedLate }}</td>
                <td class="p-3 text-right">{{ row.counts.partial }}</td>
                <td class="p-3 text-right">{{ row.counts.missedWithReason }}</td>
                <td class="p-3 text-right">{{ row.counts.missedWithoutReason }}</td>
                <td class="p-3 text-right">{{ row.counts.pending }}</td>
                <td class="p-3 text-right">{{ row.counts.notExpected }}</td>
                <td class="p-3 text-right">
                  {{ row.completionPercent === null ? '—' : `${row.completionPercent}%` }}
                </td>
              </tr>
              <tr v-if="compliance.rows.length === 0">
                <td colspan="10" class="text-text-secondary p-4">
                  No check windows fall in that period.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ----------------------------------------------------------- daily -->
    <section v-else-if="tab === 'daily'" class="space-y-3">
      <p class="text-text-secondary">
        One participant's day, or a run of days: every check window with its values or its reason,
        every medication dose and what happened to it, every diary entry, and who recorded each one.
        Suitable for handing to a family or an auditor.
      </p>

      <p v-if="participantId === ''" class="card text-text-secondary p-4">
        Choose a participant above. A daily report is about one person.
      </p>

      <a v-else :href="pdfUrl" class="btn btn-primary inline-flex" target="_blank" rel="noopener">
        Download the PDF
      </a>
    </section>

    <!-- ---------------------------------------------------------- trends -->
    <section v-else-if="tab === 'trends'" class="space-y-3">
      <p v-if="participantId === ''" class="card text-text-secondary p-4">
        Choose a participant above. A trend is one field for one person.
      </p>

      <template v-else>
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-52">
            <label class="field-label" for="trend-field">Field</label>
            <select
              id="trend-field"
              v-model="fieldKey"
              class="field"
              :aria-invalid="guard.invalid('trend-field')"
              @change="guard.clear()"
            >
              <option v-for="field in trendFields" :key="field.fieldKey" :value="field.fieldKey">
                {{ field.label }}{{ field.unit ? ` (${field.unit})` : '' }}
              </option>
            </select>
          </div>
          <div class="min-w-40">
            <label class="field-label" for="trend-bucket">Show</label>
            <select id="trend-bucket" v-model="bucket" class="field">
              <option value="none">Every reading</option>
              <option value="day">Daily average</option>
              <option value="week">Weekly average</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary" :disabled="busy" @click="loadTrend">
            {{ busy ? 'Loading' : 'Show trend' }}
          </button>
        </div>

        <p v-if="trendFields.length === 0" class="card text-text-secondary p-4">
          This participant has no numeric readings recorded yet.
        </p>

        <TrendChart v-if="series" :series="series" />
      </template>
    </section>

    <!-- ---------------------------------------------------------- export -->
    <section v-else class="space-y-3">
      <p v-if="!isAdmin" class="card text-text-secondary p-4">
        Only an admin can export records. The compliance report above has the numbers.
      </p>

      <template v-else>
        <p class="text-text-secondary">
          Raw records as a CSV, one row per record. Every export is recorded in the audit log with
          who ran it and what it covered.
        </p>

        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-40">
            <label class="field-label" for="export-kind">Records</label>
            <select id="export-kind" v-model="exportKind" class="field">
              <option value="checks">Check entries</option>
              <option value="diary">Diary entries</option>
              <option value="medications">Medication sign-offs</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary" :disabled="busy" @click="runExport">
            {{ busy ? 'Preparing' : 'Export' }}
          </button>
        </div>

        <p v-if="exportMessage" class="text-text-secondary text-sm">{{ exportMessage }}</p>

        <div v-if="exportJobs.length > 0" class="space-y-2">
          <h2 class="text-lg font-semibold">Large exports</h2>
          <ul class="space-y-2">
            <li
              v-for="job in exportJobs"
              :key="job.id"
              class="card flex flex-wrap items-center gap-3 p-3 text-sm"
            >
              <span>{{ exportKindLabel(job.kind) }}</span>
              <span class="text-text-secondary">{{ job.from }} to {{ job.to }}</span>
              <span class="text-text-secondary">{{ describeJob(job) }}</span>
              <a
                v-if="job.status === 'ready'"
                :href="api.exportDownloadUrl(job.id)"
                class="text-primary ml-auto min-h-11 underline"
              >
                Download
              </a>
              <button
                v-else-if="job.status !== 'failed'"
                type="button"
                class="text-primary ml-auto min-h-11 underline"
                @click="loadExportJobs"
              >
                Check again
              </button>
            </li>
          </ul>
        </div>
      </template>
    </section>
  </div>
</template>
