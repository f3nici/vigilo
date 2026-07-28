<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import { useOfflineStore } from '@/stores/offline';
import { useSessionStore } from '@/stores/session';

/**
 * Unlock on reopen (doc 06 §2).
 *
 * The records on this device are encrypted with a key that only exists while
 * the app is unlocked, so this is not a second sign-in: it is what makes the
 * local database readable at all. It works with no signal, which is the whole
 * point.
 *
 * "Use a PIN instead" is always available, because a fingerprint reader that
 * will not read a wet hand at 6am is not a reason to be locked out of a
 * participant's emergency plan.
 */
const router = useRouter();
const offline = useOfflineStore();
const session = useSessionStore();

const method = ref<'biometric' | 'pin' | null>(null);
const pin = ref('');
const error = ref('');
const busy = ref(false);
const showPin = ref(false);

onMounted(async () => {
  const state = await offline.enrolmentState();
  if (!state.enrolled) {
    await router.replace({ name: 'install' });
    return;
  }

  method.value = state.biometric ? 'biometric' : 'pin';
  showPin.value = !state.biometric;

  // Try straight away where the device does biometrics, so the common path is
  // open the app, look at it, and you are in.
  if (state.biometric) await unlockBiometric();
});

async function unlockBiometric(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    if (await offline.unlockWithBiometric()) {
      await done();
      return;
    }
    showPin.value = true;
  } finally {
    busy.value = false;
  }
}

async function unlockPin(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    if (await offline.unlockWithPin(pin.value)) {
      pin.value = '';
      await done();
      return;
    }
    error.value = 'That PIN did not work.';
  } finally {
    busy.value = false;
  }
}

async function done(): Promise<void> {
  const userId = session.principal?.userId;
  if (userId) await offline.start(userId);
  await router.replace({ name: 'today' });
}

/**
 * Signing out clears the local records and forgets the unlock.
 *
 * Offered here because somebody who cannot get in needs a way forward that is
 * not "reinstall the app". Anything unsent is pushed first if there is signal.
 */
async function signOutInstead(): Promise<void> {
  await offline.signOut();
  await session.signOut();
  await router.replace({ name: 'sign-in' });
}
</script>

<template>
  <section class="mx-auto max-w-sm space-y-4 pt-8">
    <div class="text-primary flex items-center justify-center gap-3">
      <VigiloMark :size="40" />
      <h1 class="text-text text-2xl font-semibold tracking-tight">Vigilo</h1>
    </div>

    <div class="card space-y-4 p-4">
      <h2 class="text-lg font-semibold">Unlock</h2>
      <FormError :message="error" />

      <button
        v-if="method === 'biometric'"
        type="button"
        class="btn btn-primary w-full"
        :disabled="busy"
        @click="unlockBiometric"
      >
        Unlock with fingerprint or face
      </button>

      <button
        v-if="method === 'biometric' && !showPin"
        type="button"
        class="text-text-secondary min-h-11 w-full underline"
        @click="showPin = true"
      >
        Use a PIN instead
      </button>

      <form v-if="showPin" class="space-y-2" @submit.prevent="unlockPin">
        <label class="field-label" for="unlock-pin">PIN</label>
        <input
          id="unlock-pin"
          v-model="pin"
          type="password"
          inputmode="numeric"
          autocomplete="current-password"
          class="field"
          autofocus
        />
        <button type="submit" class="btn btn-primary w-full" :disabled="busy">Unlock</button>
      </form>

      <button
        type="button"
        class="text-text-secondary min-h-11 w-full underline"
        @click="signOutInstead"
      >
        Sign out on this device
      </button>
    </div>
  </section>
</template>
