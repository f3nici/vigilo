<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { canManageTemplates } from '@vigilo/shared';
import ThemeToggle from './ThemeToggle.vue';
import VigiloMark from './VigiloMark.vue';
import { useSessionStore } from '@/stores/session';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const nav = computed(() => {
  const items = [
    { name: 'today', label: 'Today' },
    { name: 'participants', label: 'Participants' },
  ];
  if (canManageTemplates(session.principal?.role ?? 'worker')) {
    items.push({ name: 'check-templates', label: 'Check forms' });
  }
  if (session.principal?.role === 'admin') items.push({ name: 'users', label: 'People' });
  items.push({ name: 'system', label: 'System' });
  return items;
});

async function signOut(): Promise<void> {
  await session.signOut();
  await router.push({ name: 'sign-in' });
}
</script>

<template>
  <div class="min-h-dvh">
    <header class="border-border-default bg-surface border-b">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <RouterLink :to="{ name: 'today' }" class="text-primary flex items-center gap-2">
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
        </nav>
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
