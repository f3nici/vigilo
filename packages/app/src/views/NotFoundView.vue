<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-4">
    <h1 class="text-2xl font-semibold">Page not found</h1>
    <p class="text-text-secondary">That page does not exist, or it has moved.</p>
    <RouterLink :to="{ name: 'today' }" class="btn btn-primary self-start">Go to Today</RouterLink>
  </div>
</template>
