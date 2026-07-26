<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import { useSessionStore } from '@/stores/session';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

type Step = 'credentials' | 'totp' | 'recovery';

const step = ref<Step>('credentials');
const email = ref('');
const password = ref('');
const code = ref('');
const challengeId = ref('');
const error = ref('');
const busy = ref(false);

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return 'Could not reach the server. Check your connection and try again.';
}

async function finish(): Promise<void> {
  await session.refresh();

  if (session.pendingStep === 'password') {
    await router.push({ name: 'set-password' });
    return;
  }
  if (session.pendingStep === 'totp') {
    await router.push({ name: 'set-up-two-factor' });
    return;
  }

  const redirect = route.query.redirect;
  await router.push(typeof redirect === 'string' ? redirect : { name: 'today' });
}

async function submitCredentials(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.login(email.value, password.value);
    if (result.result === 'totp_required') {
      challengeId.value = result.challengeId;
      step.value = 'totp';
      return;
    }
    await finish();
  } catch (err) {
    error.value = messageFor(err);
  } finally {
    busy.value = false;
  }
}

async function submitSecondFactor(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    if (step.value === 'recovery') {
      await api.submitRecoveryCode(challengeId.value, code.value);
    } else {
      await api.submitTotp(challengeId.value, code.value);
    }
    await finish();
  } catch (err) {
    error.value = messageFor(err);
    code.value = '';
  } finally {
    busy.value = false;
  }
}

function useRecoveryCode(): void {
  step.value = 'recovery';
  code.value = '';
  error.value = '';
}

function startAgain(): void {
  step.value = 'credentials';
  password.value = '';
  code.value = '';
  challengeId.value = '';
  error.value = '';
}
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-8">
    <div class="text-primary flex items-center gap-3">
      <VigiloMark :size="40" />
      <span class="text-text text-2xl font-semibold tracking-tight">Vigilo</span>
    </div>

    <form
      v-if="step === 'credentials'"
      class="card space-y-4 p-6"
      @submit.prevent="submitCredentials"
    >
      <h1 class="text-lg font-semibold">Sign in</h1>

      <FormError :message="error" />

      <div>
        <label class="field-label" for="email">Email</label>
        <input
          id="email"
          v-model="email"
          class="field"
          type="email"
          autocomplete="username"
          inputmode="email"
          required
          :disabled="busy"
        />
      </div>

      <div>
        <label class="field-label" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          class="field"
          type="password"
          autocomplete="current-password"
          required
          :disabled="busy"
        />
      </div>

      <button class="btn btn-primary w-full" type="submit" :disabled="busy">
        {{ busy ? 'Signing in' : 'Sign in' }}
      </button>

      <p class="text-text-secondary text-sm">
        Accounts are created by an admin. If you cannot get in, ask them to reset your password.
      </p>
    </form>

    <form v-else class="card space-y-4 p-6" @submit.prevent="submitSecondFactor">
      <h1 class="text-lg font-semibold">
        {{ step === 'recovery' ? 'Use a recovery code' : 'Enter your code' }}
      </h1>

      <p class="text-text-secondary text-sm">
        {{
          step === 'recovery'
            ? 'Each recovery code works once.'
            : 'Open your authenticator app and enter the 6-digit code.'
        }}
      </p>

      <FormError :message="error" />

      <div>
        <label class="field-label" for="code">
          {{ step === 'recovery' ? 'Recovery code' : 'Code' }}
        </label>
        <input
          id="code"
          v-model="code"
          class="field tabular"
          :inputmode="step === 'recovery' ? 'text' : 'numeric'"
          :autocomplete="step === 'recovery' ? 'off' : 'one-time-code'"
          required
          :disabled="busy"
        />
      </div>

      <button class="btn btn-primary w-full" type="submit" :disabled="busy">
        {{ busy ? 'Checking' : 'Continue' }}
      </button>

      <div class="flex flex-wrap gap-4 text-sm">
        <button
          v-if="step === 'totp'"
          type="button"
          class="text-primary underline"
          @click="useRecoveryCode"
        >
          Use a recovery code instead
        </button>
        <button type="button" class="text-text-secondary underline" @click="startAgain">
          Start again
        </button>
      </div>
    </form>
  </div>
</template>
