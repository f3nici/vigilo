<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { TotpEnrolResponse } from '@vigilo/shared';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import QrCode from '@/components/QrCode.vue';
import { useSessionStore } from '@/stores/session';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { needs, needsText, useFormGuard } from '@/lib/forms';

/**
 * Two-factor is mandatory for admin, team leader and nurse (doc 01 §10).
 * Recovery codes are shown once here and never again, which the screen says
 * plainly rather than burying.
 */
const session = useSessionStore();
const router = useRouter();

const enrolment = ref<TotpEnrolResponse | null>(null);
const code = ref('');
const error = ref('');
const busy = ref(false);
const acknowledged = ref(false);

onMounted(async () => {
  try {
    enrolment.value = await api.beginTotpEnrolment();
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not start setting up two-factor.';
  }
});

const guard = useFormGuard();

async function confirm(): Promise<void> {
  if (
    busy.value ||
    !guard.ready(
      needs(
        'acknowledged',
        acknowledged.value,
        'Save the recovery codes first, then tick the box. They are shown once and are the only way back in.',
      ),
      needsText('code', code.value, 'Type the six-digit code your authenticator app is showing.'),
    )
  ) {
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    await api.confirmTotpEnrolment(code.value);
    await session.refresh();
    await router.push({ name: 'home' });
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not confirm that code. Try again.';
    code.value = '';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-4 py-8">
    <div class="text-primary flex items-center gap-3">
      <VigiloMark :size="40" />
      <span class="text-text text-2xl font-semibold tracking-tight">Vigilo</span>
    </div>

    <div class="card space-y-4 p-6">
      <h1 class="text-lg font-semibold">Set up two-factor authentication</h1>
      <p class="text-text-secondary text-sm">
        Your role needs a second factor. Scan this with an authenticator app, then enter the code it
        shows.
      </p>

      <FormError :message="guard.problem.value?.message ?? error" />

      <template v-if="enrolment">
        <div class="flex justify-center py-2">
          <QrCode :value="enrolment.provisioningUri" :size="200" />
        </div>

        <details class="text-sm">
          <summary class="text-primary cursor-pointer">Cannot scan? Enter the key by hand</summary>
          <p class="tabular mt-2 break-all">{{ enrolment.secret }}</p>
        </details>

        <div class="border-border-default rounded-lg border p-4">
          <h2 class="font-semibold">Recovery codes</h2>
          <p class="text-text-secondary mt-1 text-sm">
            Shown once, right now. Each works a single time, and they are the only way back in if
            you lose your phone. Print them or write them down and keep them somewhere safe.
          </p>
          <ul class="tabular mt-3 grid grid-cols-2 gap-1 text-sm">
            <li v-for="recoveryCode in enrolment.recoveryCodes" :key="recoveryCode">
              {{ recoveryCode }}
            </li>
          </ul>
          <label class="mt-3 flex items-start gap-2 text-sm">
            <input
              id="acknowledged"
              v-model="acknowledged"
              type="checkbox"
              class="mt-1 size-5"
              :aria-invalid="guard.invalid('acknowledged')"
              @change="guard.clear()"
            />
            <span>I have saved these codes somewhere safe.</span>
          </label>
        </div>

        <form class="space-y-4" @submit.prevent="confirm">
          <div>
            <label class="field-label" for="code">Code from your app</label>
            <input
              id="code"
              v-model="code"
              class="field tabular"
              inputmode="numeric"
              autocomplete="one-time-code"
              :disabled="busy"
              :aria-invalid="guard.invalid('code')"
              @input="guard.clear()"
            />
          </div>

          <button class="btn btn-primary w-full" type="submit" :disabled="busy">
            {{ busy ? 'Checking' : 'Confirm and finish' }}
          </button>
        </form>
      </template>
    </div>
  </div>
</template>
