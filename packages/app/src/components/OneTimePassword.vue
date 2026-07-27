<script setup lang="ts">
import { ref } from 'vue';

/**
 * A one-time password, shown once (doc 01 §10). It is not stored anywhere in
 * plaintext and cannot be retrieved again, so the screen says so rather than
 * letting an admin dismiss it and assume they can look it up later.
 */
defineProps<{ email: string; password: string }>();
const emit = defineEmits<{ dismiss: [] }>();

const copied = ref(false);

async function copy(password: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(password);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard is blocked in some contexts. The password is on screen anyway.
  }
}
</script>

<template>
  <div class="card p-4" :style="{ borderColor: 'var(--vigilo-primary)' }" role="status">
    <h2 class="font-semibold">One-time password for {{ email }}</h2>

    <p class="tabular my-3 text-xl font-semibold break-all">{{ password }}</p>

    <p class="text-text-secondary text-sm">
      Shown once. Hand it over directly, in person or by phone. Vigilo does not send email, does not
      keep this password, and cannot show it again. They will have to change it when they sign in.
    </p>

    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn border-border-default border px-3" type="button" @click="copy(password)">
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
      <button class="btn btn-primary px-3" type="button" @click="emit('dismiss')">
        I have handed it over
      </button>
    </div>
  </div>
</template>
