<script setup lang="ts">
import { computed } from 'vue';
import {
  dayIsEmpty,
  describeMyCheck,
  emptyDayMessage,
  myDayTimeline,
  type MyDay,
} from '@vigilo/shared';
import { formatWindowTime } from '@/lib/format';

/**
 * One day of somebody's own record (doc 06 §6).
 *
 * Used by both self-access screens, so a day looks the same whether it was
 * reached by opening the app this morning or by picking a date last month.
 *
 * Larger type and more space than the staff screens. This is read by the
 * person it is about, sometimes with a support worker leaning over, sometimes
 * at arm's length, and the staff density that lets a team leader scan twelve
 * windows is the wrong trade here.
 */
const props = defineProps<{
  day: MyDay;
  today: string;
  timeZone: string;
  /** Off on the single-day screen, which already says the date at the top. */
  showDate?: boolean;
}>();

const empty = computed(() => dayIsEmpty(props.day));

/*
 * One list, oldest first, checks and diary entries interleaved. The ordering
 * lives in shared so the PDF reads the same way down the page.
 */
const timeline = computed(() => myDayTimeline(props.day));

const heading = computed(() =>
  new Intl.DateTimeFormat('en-AU', {
    timeZone: props.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${props.day.date}T12:00:00Z`)),
);

const time = (iso: string) => formatWindowTime(iso, props.timeZone);
</script>

<template>
  <section class="space-y-4">
    <h3 v-if="showDate" class="text-lg font-semibold">{{ heading }}</h3>

    <p v-if="empty" class="text-text-secondary text-lg">
      {{ emptyDayMessage(day.date, today) }}
    </p>

    <template v-else>
      <article v-for="item in timeline" :key="item.at + item.kind" class="card space-y-2 p-5">
        <template v-if="item.kind === 'check'">
          <p class="text-lg font-semibold">
            <span class="tabular">{{ time(item.check.recordedAt) }}</span>
            &nbsp;{{ describeMyCheck(item.check) }}
          </p>

          <!--
            A description list rather than a table: one reading per row reads
            straight down on a phone, and a table of two columns does not.
          -->
          <dl class="space-y-1 text-lg">
            <div
              v-for="value in item.check.values"
              :key="value.fieldKey"
              class="flex flex-wrap gap-x-2"
            >
              <dt class="text-text-secondary">{{ value.label }}</dt>
              <dd class="font-medium">{{ value.display }}</dd>
            </div>
          </dl>
          <p v-if="item.check.values.length === 0" class="text-text-secondary">
            No readings were written on this one.
          </p>
        </template>

        <template v-else>
          <p class="text-lg font-semibold">
            <span class="tabular">{{ time(item.entry.occurredAt) }}</span>
            &nbsp;{{ item.entry.categoryLabel }}
          </p>

          <p class="text-lg leading-relaxed whitespace-pre-wrap">{{ item.entry.body }}</p>

          <!--
          Thumbnails that open the full photo. The link is a plain anchor
          because the server serves an attachment with a sandbox CSP and never
          inline, so opening it is a download rather than a render in our own
          origin (doc 07 §7).
        -->
          <ul v-if="item.entry.photos.length > 0" class="flex flex-wrap gap-3">
            <li v-for="photo in item.entry.photos" :key="photo.id">
              <a v-if="photo.isImage" :href="`/api/v1/attachments/${photo.id}`" class="block">
                <img
                  :src="`/api/v1/attachments/${photo.id}/thumb`"
                  alt="Photo on this entry"
                  class="border-border-default size-24 rounded-lg border object-cover"
                />
              </a>
              <a v-else :href="`/api/v1/attachments/${photo.id}`" class="btn card">
                Download the file
              </a>
            </li>
          </ul>

          <p v-if="item.entry.recordedByName || item.entry.edited" class="text-text-secondary">
            <span v-if="item.entry.recordedByName">Written by {{ item.entry.recordedByName }}</span>
            <!--
              Doc 06 §7 says an edited record shows it. The participant gets the
              fact without the revision history, which is a staff view.
            -->
            <span v-if="item.entry.recordedByName && item.entry.edited"> · </span>
            <span v-if="item.entry.edited">edited since it was written</span>
          </p>
        </template>
      </article>
    </template>
  </section>
</template>
