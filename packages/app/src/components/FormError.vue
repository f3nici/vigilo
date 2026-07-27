<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <p
    v-if="message"
    class="rounded-lg border px-3 py-2 text-sm"
    :style="{ borderColor: 'var(--vigilo-missed)', color: 'var(--vigilo-missed)' }"
    role="alert"
  >
    {{ message }}
  </p>
</template>
