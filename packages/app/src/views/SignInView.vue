<script setup lang="ts">
import { RouterLink } from 'vue-router';
import VigiloMark from '@/components/VigiloMark.vue';
import { useSessionStore } from '@/stores/session';

/**
 * The sign-in screen exists so Phase 1 has a place to put identity. It cannot
 * sign anyone in yet, and it says so rather than pretending with a disabled
 * form that looks real.
 */
const session = useSessionStore();
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
    <div class="text-primary flex items-center gap-3">
      <VigiloMark :size="40" />
      <span class="text-text text-2xl font-semibold tracking-tight">Vigilo</span>
    </div>

    <div class="card p-6">
      <h1 class="text-lg font-semibold">Sign-in is not built yet</h1>
      <p class="text-text-secondary mt-2">
        Accounts, passwords, two-factor and access scope arrive in Phase 1. Until then the app shell
        is open so the foundations can be reviewed.
      </p>
      <p class="text-text-secondary mt-2 text-sm">
        This browser would use the
        <strong>{{
          session.authModel === 'session-cookie' ? 'office session' : 'installed app'
        }}</strong>
        model.
      </p>
      <RouterLink :to="{ name: 'today' }" class="btn btn-primary mt-4">Continue</RouterLink>
    </div>
  </div>
</template>
