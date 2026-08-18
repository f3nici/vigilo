<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { canRecordChecks } from '@vigilo/shared';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import { isInstalled } from '@/platform';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';

/**
 * Install (doc 06 §2.1).
 *
 * Not a dismissible nag. Without installing, a field worker has no reliable
 * offline storage, which means the app cannot do the job it exists for. An
 * admin at a desk can skip it for good.
 *
 * Android and desktop Chromium get one tap through `beforeinstallprompt`. iOS
 * has no install API and never has, so it gets the Share-menu instructions,
 * done properly rather than as a sentence in small type.
 */
const router = useRouter();
const session = useSessionStore();
const offline = useOfflineStore();

const error = ref('');
const busy = ref(false);
const step = ref<'install' | 'unlock' | 'done'>('install');
const pin = ref('');
const pinAgain = ref('');
const biometricOffered = ref(false);

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const deferred = ref<InstallPrompt | null>(null);

const platform = computed<'ios' | 'android' | 'desktop'>(() => {
  const agent = navigator.userAgent;
  // iPadOS reports itself as a Mac, so touch points are what actually
  // distinguishes an iPad from a desktop Safari.
  const iPadOS = agent.includes('Macintosh') && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(agent) || iPadOS) return 'ios';
  if (/Android/.test(agent)) return 'android';
  return 'desktop';
});

const fieldRole = computed(() => canRecordChecks(session.principal?.role ?? 'worker'));
const alreadyInstalled = computed(() => isInstalled());

function capture(event: Event): void {
  event.preventDefault();
  deferred.value = event as InstallPrompt;
}

onMounted(async () => {
  window.addEventListener('beforeinstallprompt', capture);
  if (alreadyInstalled.value) step.value = 'unlock';
  biometricOffered.value = await offline.enrolmentState().then((state) => state.biometric);
});

onUnmounted(() => window.removeEventListener('beforeinstallprompt', capture));

async function install(): Promise<void> {
  const prompt = deferred.value;
  if (!prompt) return;

  await prompt.prompt();
  const choice = await prompt.userChoice;
  deferred.value = null;
  if (choice.outcome === 'accepted') step.value = 'unlock';
}

/**
 * Persistent storage, asked for at install (doc 05 §8.1).
 *
 * An installed PWA is usually granted it, and it is the single biggest thing
 * standing between an unsent outbox and iOS deciding to reclaim the space.
 */
async function requestPersistence(): Promise<void> {
  await offline.sync();
}

async function setUpBiometric(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const user = session.principal;
    if (!user) return;
    const ok = await offline.enrolBiometric(user.userId, user.displayName);
    if (!ok) {
      // The device registered a credential but cannot derive a key from it,
      // which is most of Safari today. The PIN is the honest fallback.
      error.value =
        'This device cannot use its fingerprint or face to protect the records. Set a PIN instead.';
      biometricOffered.value = false;
      return;
    }
    step.value = 'done';
  } catch (err) {
    // Whatever the authenticator threw is for the console, not for somebody
    // standing at a front door trying to set their phone up (#23).
    console.error('biometric enrolment', err);
    error.value = 'This device could not set that up. Set a PIN instead.';
  } finally {
    busy.value = false;
  }
}

async function setUpPin(): Promise<void> {
  error.value = '';
  if (pin.value.length < 6) {
    error.value = 'Use at least 6 digits.';
    return;
  }
  if (pin.value !== pinAgain.value) {
    error.value = 'The two PINs do not match.';
    return;
  }

  busy.value = true;
  try {
    await offline.enrolPin(pin.value);
    pin.value = '';
    pinAgain.value = '';
    step.value = 'done';
  } finally {
    busy.value = false;
  }
}

async function finish(): Promise<void> {
  await requestPersistence();
  await router.push({ name: 'home' });
}

function later(): void {
  void router.push({ name: 'home' });
}
</script>

<template>
  <section class="mx-auto max-w-lg space-y-4">
    <div class="text-primary flex items-center gap-3">
      <VigiloMark :size="40" />
      <h1 class="text-text text-2xl font-semibold tracking-tight">Vigilo</h1>
    </div>

    <FormError :message="error" />

    <div v-if="step === 'install'" class="card space-y-4 p-4">
      <h2 class="text-lg font-semibold">Add Vigilo to your home screen</h2>

      <p class="text-text-secondary">You need to install it to:</p>
      <ul class="list-disc space-y-1 pl-5">
        <li>Record checks with no signal</li>
        <li>Get reminders when a check is due</li>
        <li>Open it without signing in again</li>
      </ul>

      <!-- iOS has no install API, so this is the only path there is. -->
      <div v-if="platform === 'ios'" class="space-y-2">
        <h3 class="font-semibold">On iPhone and iPad</h3>
        <ol class="list-decimal space-y-2 pl-5">
          <li>
            Tap
            <span class="border-border-default rounded border px-1.5 py-0.5" aria-hidden="true"
              >⬆︎</span
            >
            <span class="font-semibold">&nbsp;Share</span> at the bottom of the screen.
          </li>
          <li>Scroll down and tap <span class="font-semibold">Add to Home Screen</span>.</li>
          <li>
            Tap <span class="font-semibold">Add</span>, then open Vigilo from your home screen.
          </li>
        </ol>
        <p class="text-text-secondary text-sm">
          Reliable offline storage only works once Vigilo is on the home screen. That is a Safari
          rule, not ours.
        </p>
      </div>

      <div v-else-if="deferred" class="space-y-2">
        <button type="button" class="btn btn-primary w-full" @click="install">
          Install Vigilo
        </button>
      </div>

      <div v-else class="space-y-2">
        <h3 class="font-semibold">On this device</h3>
        <p v-if="platform === 'android'">
          Open the browser menu and choose <span class="font-semibold">Install app</span> or
          <span class="font-semibold">Add to Home screen</span>.
        </p>
        <p v-else>
          Use the install button in the address bar, or the browser menu, and choose
          <span class="font-semibold">Install Vigilo</span>.
        </p>
      </div>

      <div class="flex flex-wrap gap-3">
        <button type="button" class="btn border-border-default border" @click="step = 'unlock'">
          I have installed it
        </button>
        <button
          v-if="!fieldRole"
          type="button"
          class="text-text-secondary min-h-11 underline"
          @click="later"
        >
          Not now
        </button>
      </div>

      <!--
        Doc 05 §10. A tab has no reliable offline storage and no push on iOS, so
        a field worker running in one is told what they lose rather than left
        to find out during a shift.
      -->
      <p v-if="fieldRole" class="text-text-secondary text-sm">
        Until then, records you make in this browser tab may not be saved if you lose signal.
      </p>
    </div>

    <div v-else-if="step === 'unlock'" class="card space-y-4 p-4">
      <h2 class="text-lg font-semibold">Protect the records on this device</h2>
      <p class="text-text-secondary">
        Vigilo keeps names and notes on the phone so it works with no signal. They are encrypted,
        and this is the unlock that opens them.
      </p>

      <button
        v-if="biometricOffered"
        type="button"
        class="btn btn-primary w-full"
        :disabled="busy"
        @click="setUpBiometric"
      >
        Use this device's fingerprint or face
      </button>

      <div class="space-y-2">
        <label class="field-label" for="pin">
          {{ biometricOffered ? 'Or set a PIN' : 'Set a PIN' }}
        </label>
        <input
          id="pin"
          v-model="pin"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          class="field"
          placeholder="At least 6 digits"
        />
        <label class="field-label" for="pin-again">Enter it again</label>
        <input
          id="pin-again"
          v-model="pinAgain"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          class="field"
        />
        <button
          type="button"
          class="btn border-border-default w-full border"
          :disabled="busy"
          @click="setUpPin"
        >
          Set PIN
        </button>
      </div>
    </div>

    <div v-else class="card space-y-4 p-4">
      <h2 class="text-lg font-semibold">Ready</h2>
      <p class="text-text-secondary">
        Vigilo will keep working with no signal, and send everything as soon as it has some.
      </p>
      <button type="button" class="btn btn-primary w-full" @click="finish">Go to Today</button>
    </div>
  </section>
</template>
