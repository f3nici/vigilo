<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';
import ThemeToggle from './ThemeToggle.vue';
import VigiloMark from './VigiloMark.vue';

const route = useRoute();

const nav = [
  { name: 'today', label: 'Today' },
  { name: 'participants', label: 'Participants' },
  { name: 'system', label: 'System' },
] as const;
</script>

<template>
  <div class="min-h-dvh">
    <p
      class="bg-primary-subtle text-text-secondary border-border-default border-b px-4 py-2 text-sm"
      role="status"
    >
      Phase 0 foundations. There is no sign-in yet, and no participant records exist.
    </p>

    <header class="border-border-default bg-surface border-b">
      <div class="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
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
    </header>

    <main class="mx-auto max-w-5xl px-4 py-6">
      <RouterView />
    </main>
  </div>
</template>
