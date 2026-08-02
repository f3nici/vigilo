<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';

/**
 * High contrast on and off (doc 06 §7).
 *
 * Sits next to the light and dark toggle because it is the same kind of
 * choice, and it is deliberately reachable from every screen rather than
 * buried in settings: somebody who needs it needs it on the screen they are
 * currently unable to read.
 */
const theme = useThemeStore();

const high = computed(() => theme.contrast === 'high');
const label = computed(() => (high.value ? 'Turn off high contrast' : 'Turn on high contrast'));

function toggle(): void {
  theme.setContrast(high.value ? 'normal' : 'high');
}
</script>

<template>
  <button
    type="button"
    class="text-text-secondary hover:bg-primary-subtle flex size-11 items-center justify-center rounded-lg"
    :class="high ? 'bg-primary-subtle text-primary' : ''"
    :aria-label="label"
    :aria-pressed="high"
    :title="label"
    @click="toggle"
  >
    <!-- A half-filled circle: the usual sign for contrast, and it reads at
         this size without colour. -->
    <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
    </svg>
  </button>
</template>
