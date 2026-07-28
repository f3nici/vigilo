<script setup lang="ts">
import { ref } from 'vue';
import { applyUpdate, entryInProgress, updateReady } from '@/sw/register';

/**
 * A new version, waiting (doc 05 §10, doc 06 §7).
 *
 * Never applied automatically and never applied over an open form. A strip
 * rather than a dialog, because an update is not urgent and a modal in front
 * of a half-finished set of observations is the exact interruption the rule
 * exists to prevent.
 */
const blocked = ref(false);

function update(): void {
  blocked.value = !applyUpdate();
}
</script>

<template>
  <div
    v-if="updateReady"
    class="bg-primary-subtle border-border-default border-b px-4 py-2 text-sm"
    role="status"
  >
    <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
      <span>A new version of Vigilo is ready.</span>
      <button type="button" class="text-primary min-h-11 underline" @click="update">
        Update now
      </button>
      <span v-if="blocked || entryInProgress" class="text-text-secondary">
        It will wait until you have saved what you are working on.
      </span>
    </div>
  </div>
</template>
