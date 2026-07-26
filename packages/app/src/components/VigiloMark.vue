<script setup lang="ts">
/**
 * The app icon from doc 08 §5: a filled circle inside a rounded arc that does
 * not quite close. The arc is the repeating round, the circle is both an eye
 * and a recorded data point. It has to work at 48px.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 28 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M26 10.5A12 12 0 1 0 27.5 16"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
    />
    <circle cx="16" cy="16" r="5" fill="currentColor" />
  </svg>
</template>
