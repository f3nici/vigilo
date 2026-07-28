<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatDateTimeIn } from '@/lib/format';
import { useOfflineStore } from '@/stores/offline';
import { useSessionStore } from '@/stores/session';

/**
 * The sync indicator (doc 05 §5, doc 06 §1).
 *
 * Always visible, and a hard requirement rather than a nicety: a silent queue
 * is how records get lost and how trust gets destroyed. It states a fact, and
 * being offline is one of the facts, not an error.
 *
 * Tapping it lists what is waiting, because "3 records waiting" with no way to
 * find out which three is barely better than saying nothing.
 */
const offline = useOfflineStore();
const session = useSessionStore();

const open = ref(false);
const flagged = ref<{ opId: string; kind: string; error: string; createdAt: string }[]>([]);

const timeZone = computed(() => session.org?.timezone ?? 'Australia/Melbourne');

const dot = computed(() => {
  switch (offline.indicator) {
    case 'synced':
      return 'var(--vigilo-complete)';
    case 'pending':
      return 'var(--vigilo-syncing)';
    case 'needs_attention':
      return 'var(--vigilo-missed)';
    case 'offline':
      return 'var(--vigilo-pending)';
  }
  return 'var(--vigilo-pending)';
});

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) flagged.value = await offline.flagged();
}

const kindLabels: Record<string, string> = {
  'check_entry.put': 'A check entry',
  'miss_reason.put': 'A missed-check reason',
  'diary_entry.create': 'A diary entry',
  'diary_entry.update': 'A diary edit',
  'attachment.create': 'A photo',
};
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="text-text-secondary flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm"
      :aria-expanded="open"
      :aria-label="`Sync status: ${offline.indicatorText}`"
      @click="toggle"
    >
      <span
        class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        :style="{ backgroundColor: dot }"
        :class="offline.syncing ? 'animate-pulse' : ''"
        aria-hidden="true"
      />
      <span>{{ offline.indicatorText }}</span>
    </button>

    <div
      v-if="open"
      class="card absolute right-0 z-20 mt-1 w-80 space-y-3 p-4 text-sm shadow-lg"
      role="dialog"
      aria-label="Sync details"
    >
      <p v-if="offline.lastSyncAt">
        Last synced {{ formatDateTimeIn(offline.lastSyncAt, timeZone) }}.
      </p>
      <p v-else class="text-text-secondary">Not synced yet.</p>

      <p v-if="offline.pendingCount > 0">
        {{ offline.pendingCount }}
        {{ offline.pendingCount === 1 ? 'record is' : 'records are' }} waiting to send. They are
        saved on this device and will go as soon as there is signal.
      </p>

      <!--
        Doc 05 §8.1. iOS can throw local storage away after about a week
        unused, and it takes anything unsent with it. A worker who knows that
        opens the app near signal; a worker who does not, loses the records.
      -->
      <p
        v-if="offline.indicator === 'needs_attention' && offline.needsUserCount === 0"
        class="text-state-missed"
      >
        These have been waiting for more than a day. Open Vigilo somewhere with signal so they can
        be sent.
      </p>

      <div v-if="flagged.length > 0" class="space-y-2">
        <p class="text-state-missed font-semibold">
          The server would not accept {{ flagged.length }}
          {{ flagged.length === 1 ? 'record' : 'records' }}:
        </p>
        <ul class="space-y-1">
          <li v-for="item in flagged" :key="item.opId" class="text-text-secondary">
            {{ kindLabels[item.kind] ?? 'A record' }} from
            {{ formatDateTimeIn(item.createdAt, timeZone) }}: {{ item.error }}
          </li>
        </ul>
      </div>

      <p v-if="!offline.persisted && offline.installed" class="text-text-secondary">
        This device has not granted Vigilo permanent storage, so records saved here could be cleared
        if the phone runs low on space.
      </p>

      <button
        type="button"
        class="btn border-border-default w-full border"
        :disabled="offline.syncing"
        @click="offline.sync()"
      >
        {{ offline.syncing ? 'Syncing' : 'Sync now' }}
      </button>
    </div>
  </div>
</template>
