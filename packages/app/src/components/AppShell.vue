<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { canManageTemplates, canRecordChecks, canSyncOffline } from '@vigilo/shared';
import ContrastToggle from './ContrastToggle.vue';
import ThemeToggle from './ThemeToggle.vue';
import VigiloMark from './VigiloMark.vue';
import SyncIndicator from './SyncIndicator.vue';
import UpdatePrompt from './UpdatePrompt.vue';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const offline = useOfflineStore();

/**
 * A tab is not the product (doc 05 §10, doc 06 §7).
 *
 * Without installing, a field worker has no dependable offline storage and, on
 * iOS, no notifications. The strip says so and stays, because a worker who
 * finds this out during a shift in a house with no signal finds it out by
 * losing records.
 */
const showNotInstalled = computed(
  () => !offline.installed && canRecordChecks(session.principal?.role ?? 'worker'),
);

const syncs = computed(() => canSyncOffline(session.principal?.role ?? 'worker'));

const nav = computed(() => {
  /*
   * Three screens and nothing else (doc 06 §6). Not the staff nav with items
   * removed: a self-access account has no Today, no participant list and no
   * System, and building this from the same array would mean every future
   * staff item had to remember to exclude them.
   */
  if (session.principal?.role === 'participant') {
    return [
      { name: 'my-day', label: 'My day' },
      { name: 'my-records', label: 'My records' },
      { name: 'my-reports', label: 'My reports' },
    ];
  }

  /*
   * Participants first, and Today only for the roles that still have it (D90).
   * A worker reaches every window through the person it is about.
   */
  const items = [{ name: 'participants', label: 'Participants' }];
  if (['admin', 'team_leader', 'nurse'].includes(session.principal?.role ?? 'worker')) {
    items.unshift({ name: 'today', label: 'Today' });
  }
  if (canManageTemplates(session.principal?.role ?? 'worker')) {
    items.push({ name: 'check-templates', label: 'Check forms' });
  }
  if (['admin', 'team_leader', 'nurse'].includes(session.principal?.role ?? 'worker')) {
    items.push({ name: 'reports', label: 'Reports' });
  }
  if (session.principal?.role === 'admin') {
    items.push({ name: 'diary-categories', label: 'Diary' });
    items.push({ name: 'users', label: 'People' });
  }
  items.push({ name: 'system', label: 'System' });
  return items;
});

async function signOut(): Promise<void> {
  // Local records go first, and anything unsent is pushed before they do.
  // A self-access account has none, so this is a no-op for that role.
  await offline.signOut();
  await session.signOut();
  await router.push({ name: 'sign-in' });
}
</script>

<template>
  <div class="min-h-dvh">
    <UpdatePrompt />

    <p
      v-if="showNotInstalled"
      class="border-border-default bg-primary-subtle border-b px-4 py-2 text-center text-sm"
    >
      Not installed. Records you make here may not be saved if you lose signal.
      <RouterLink :to="{ name: 'install' }" class="text-primary underline"
        >Install Vigilo</RouterLink
      >
    </p>

    <!--
      Doc 05 §8.1. An empty screen after the browser cleared our storage looks
      exactly like data loss, so it is named rather than left to be guessed at.
    -->
    <p
      v-if="offline.wasEvicted"
      class="border-border-default bg-surface text-state-missed border-b px-4 py-2 text-center text-sm"
    >
      This device cleared its saved records. They are being downloaded again from the server.
    </p>

    <p
      v-if="offline.state === 'busy'"
      class="border-border-default bg-surface text-text-secondary border-b px-4 py-2 text-center text-sm"
    >
      Vigilo is open in another tab, which is holding the offline records. This tab needs a
      connection.
    </p>

    <header class="border-border-default bg-surface border-b">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <RouterLink :to="{ name: 'home' }" class="text-primary flex items-center gap-2">
          <VigiloMark />
          <span class="text-text text-xl font-semibold tracking-tight">Vigilo</span>
        </RouterLink>

        <nav class="ml-auto flex items-center gap-1" aria-label="Main">
          <RouterLink
            v-for="item in nav"
            :key="item.name"
            :to="{ name: item.name }"
            class="text-text-secondary hover:bg-primary-subtle flex min-h-11 items-center rounded-lg px-3 text-base"
            :class="route.name === item.name ? 'bg-primary-subtle text-primary font-semibold' : ''"
            :aria-current="route.name === item.name ? 'page' : undefined"
          >
            {{ item.label }}
          </RouterLink>
          <ThemeToggle />
          <ContrastToggle />
        </nav>
      </div>

      <!--
        The sync indicator states what is on the device and what is waiting to
        go. A self-access account has neither (doc 06 §6), so it would be a
        light that could only ever mean one thing.
      -->
      <div v-if="syncs" class="mx-auto flex max-w-5xl px-4 pb-1">
        <SyncIndicator class="ml-auto" />
      </div>

      <div
        v-if="session.principal"
        class="border-border-default text-text-secondary mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-sm"
      >
        <span>{{ session.principal.displayName }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ session.org?.name }}</span>
        <button type="button" class="ml-auto min-h-11 underline" @click="signOut">Sign out</button>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 py-6">
      <RouterView />
    </main>
  </div>
</template>
