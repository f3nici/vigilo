<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  addDays,
  describeTimelineItem,
  groupTimelineByDay,
  localDateOf,
  type CheckWindow,
  type TimelineItem,
} from '@vigilo/shared';
import CategoryChip from '@/components/CategoryChip.vue';
import StatusPill from '@/components/StatusPill.vue';
import type { RecordState } from '@/components/StatusPill.vue';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { formatDayHeading, formatWindowRange, formatWindowTime } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

/**
 * The merged timeline (doc 06 §4.2).
 *
 * Checks and diary in one list, newest first, grouped by the local day. It is
 * the first tab because it is how a shift is handed over: what happened to
 * this person, in order, not two separate lists to interleave in your head.
 *
 * The merge and the ordering come from @vigilo/shared, so the offline device
 * builds the identical list from its own tables.
 */

const session = useSessionStore();
const props = defineProps<{ participantId: string }>();

const items = ref<TimelineItem[]>([]);
const timeZone = ref(session.timeZone);
const days = ref(7);
const loading = ref(true);
const error = ref('');

const grouped = computed(() => groupTimelineByDay(items.value, timeZone.value));

/** The same mapping WindowRow uses, so one window reads the same on both. */
function stateOf(window: CheckWindow): RecordState {
  if (window.status === 'complete' && window.isLate) return 'late';
  if (window.status === 'not_expected') return 'not-expected';
  return window.status;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const today = localDateOf(new Date(), timeZone.value);
    const result = await api.getTimeline(props.participantId, {
      from: addDays(today, -(days.value - 1)),
      to: today,
    });
    items.value = result.items;
    timeZone.value = result.timeZone;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Could not load the timeline.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function setDays(value: number): Promise<void> {
  days.value = value;
  await load();
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-semibold">Timeline</h2>
      <div class="ml-auto flex gap-2 text-sm">
        <button
          v-for="option in [1, 7, 30]"
          :key="option"
          type="button"
          class="btn border-border-default min-h-11 border px-3"
          :style="days === option ? { borderColor: 'var(--vigilo-primary)' } : {}"
          @click="setDays(option)"
        >
          {{ option === 1 ? 'Today' : `${option} days` }}
        </button>
      </div>
    </div>

    <FormError :message="error" />

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <p v-else-if="items.length === 0" class="card text-text-secondary p-4">
      Nothing recorded in this period.
    </p>

    <div v-for="day in grouped" v-else :key="day.date" class="space-y-2">
      <h3 class="text-text-secondary text-sm font-semibold">
        {{ formatDayHeading(`${day.date}T12:00:00Z`, timeZone) }}
      </h3>

      <ul class="space-y-2">
        <li
          v-for="item in day.items"
          :key="`${item.kind}-${item.id}`"
          class="card p-3"
          :class="item.kind === 'diary' && item.entry.deletedAt ? 'opacity-60' : ''"
        >
          <!-- A check links to the form. A diary entry is read in place. -->
          <RouterLink
            v-if="item.kind === 'check'"
            :to="{ name: 'window', params: { id: item.window.id }, query: { tz: timeZone } }"
            class="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span class="tabular text-text-secondary">{{
              formatWindowTime(item.at, timeZone)
            }}</span>
            <span class="font-medium">
              Check {{ formatWindowRange(item.window.startsAt, item.window.endsAt, timeZone) }}
            </span>
            <StatusPill :state="stateOf(item.window)" />
            <span class="text-text-secondary w-full text-sm">
              {{ describeTimelineItem(item) }}
            </span>
          </RouterLink>

          <div v-else class="space-y-1">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="tabular text-text-secondary">
                {{ formatWindowTime(item.at, timeZone) }}
              </span>
              <CategoryChip :label="item.entry.categoryLabel" :colour="item.entry.categoryColour" />
              <span
                v-if="!item.entry.visibleToParticipant"
                class="text-text-secondary text-sm"
                :title="'Hidden from the participant'"
              >
                Staff only
              </span>
              <!-- Only an admin sees these at all, and only marked. -->
              <span v-if="item.entry.deletedAt" class="text-state-missed text-sm">Deleted</span>
            </div>
            <p>{{ describeTimelineItem(item) }}</p>
            <ul v-if="item.entry.attachments.length > 0" class="flex flex-wrap gap-2 pt-1">
              <li v-for="attachment in item.entry.attachments" :key="attachment.id">
                <a :href="api.attachmentUrl(attachment.id)">
                  <img
                    v-if="attachment.isImage"
                    :src="api.thumbnailUrl(attachment.id)"
                    :alt="attachment.filename"
                    class="h-16 w-16 rounded object-cover"
                  />
                  <span v-else class="text-primary text-sm underline">
                    {{ attachment.filename }}
                  </span>
                </a>
              </li>
            </ul>
            <p class="text-text-secondary text-sm">
              {{ item.entry.recordedByName ?? 'Someone'
              }}<span v-if="item.entry.editCount > 0"> · edited</span>
            </p>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
