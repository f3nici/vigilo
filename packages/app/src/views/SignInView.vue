<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import { useSessionStore } from '@/stores/session';
import { getPlatform, PasskeyError } from '@/platform';
import {
  localQuickSignIn,
  signInWithPasskey,
  signInWithQuickCredential,
  type LocalQuickSignIn,
} from '@/lib/signin-options';
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

/**
 * The two ways in that are not a password (#24).
 *
 * A passkey is offered wherever the browser has WebAuthn, because the
 * credential may live on a phone this laptop has never met. Quick sign-in is
 * offered only where this device has one, because it is this device's.
 */
const passkeysSupported = ref(false);
const quick = ref<LocalQuickSignIn | null>(null);
const pin = ref('');
const showPin = ref(false);

onMounted(async () => {
  quick.value = localQuickSignIn();
  passkeysSupported.value = (await getPlatform().passkeys.availability()).supported;
});

async function useQuickSignIn(): Promise<void> {
  const local = quick.value;
  if (local === null || busy.value) return;

  busy.value = true;
  error.value = '';
  try {
    const secureStore = getPlatform().secureStore;
    const unlocked =
      local.method === 'biometric'
        ? await secureStore.unlockWithBiometric()
        : await secureStore.unlockWithPin(pin.value);

    if (!unlocked) {
      // A fingerprint that will not read is not a failure worth an alarm: the
      // PIN is right there, and so is the password.
      error.value =
        local.method === 'biometric'
          ? 'That did not read. Use your PIN or your password.'
          : 'That PIN did not work.';
      showPin.value = true;
      return;
    }

    pin.value = '';
    if (await signInWithQuickCredential()) {
      await finish();
      return;
    }

    quick.value = localQuickSignIn();
    error.value = 'Quick sign-in is not set up on this device any more. Use your password.';
  } catch (err) {
    error.value = messageFor(err);
    quick.value = localQuickSignIn();
  } finally {
    busy.value = false;
  }
}

async function usePasskey(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    // False means the prompt was dismissed, which is somebody changing their
    // mind rather than something going wrong.
    if (await signInWithPasskey()) await finish();
  } catch (err) {
    error.value = messageFor(err);
  } finally {
    busy.value = false;
  }
}

function messageFor(err: unknown): string {
  // A passkey ceremony that failed says what went wrong in its own words.
  if (err instanceof PasskeyError) return err.message;
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
  await router.push(typeof redirect === 'string' ? redirect : { name: 'home' });
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

      <!--
        The other ways in (#24). Under the password rather than above it: the
        password is what everybody has and what an admin can hand back, and
        these are the shortcuts somebody has set up for themselves.
      -->
      <div v-if="quick || passkeysSupported" class="border-border-default space-y-2 border-t pt-4">
        <template v-if="quick">
          <button
            v-if="quick.method === 'biometric' && !showPin"
            type="button"
            class="btn border-border-default w-full border"
            :disabled="busy"
            @click="useQuickSignIn"
          >
            Sign in with fingerprint or face
          </button>

          <div v-else class="space-y-2">
            <label class="field-label" for="quick-pin">PIN for this device</label>
            <input
              id="quick-pin"
              v-model="pin"
              class="field"
              type="password"
              inputmode="numeric"
              autocomplete="off"
              :disabled="busy"
              @keyup.enter="useQuickSignIn"
            />
            <button
              type="button"
              class="btn border-border-default w-full border"
              :disabled="busy"
              @click="useQuickSignIn"
            >
              Sign in with this PIN
            </button>
          </div>
        </template>

        <button
          v-if="passkeysSupported"
          type="button"
          class="btn border-border-default w-full border"
          :disabled="busy"
          @click="usePasskey"
        >
          Sign in with a passkey
        </button>
      </div>

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
