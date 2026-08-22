<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { describePasskey, type PasskeySummary, type QuickSignInSummary } from '@vigilo/shared';
import FormError from '@/components/FormError.vue';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { canOfferBiometric, getPlatform, isInstalled, PasskeyError } from '@/platform';
import {
  addPasskey,
  enableQuickSignIn,
  forgetQuickSignIn,
  localQuickSignIn,
  type LocalQuickSignIn,
} from '@/lib/signin-options';
import { useOfflineStore } from '@/stores/offline';
import { useSessionStore } from '@/stores/session';
import { needs, needsText, useFormGuard } from '@/lib/forms';

/**
 * How this person gets in, set up by them rather than by an admin (#24).
 *
 * Three ways, and they are not the same kind of thing, so the screen says so
 * rather than presenting a row of equivalent switches:
 *
 * - A **passkey** is a real credential and it travels. Set one up on a phone
 *   and it signs you in on the laptop too, because the phone's keychain took
 *   it with it. It stands in for the password and the second factor together.
 * - A **PIN** and a **fingerprint** are this device only. They release
 *   something this device already holds, which is why they can be set up here
 *   and cannot be moved.
 *
 * The password never goes away. An account with no password is an account an
 * admin cannot hand back to somebody who has lost their phone, and there is no
 * email in this system to recover one with (doc 01 §10).
 */
const session = useSessionStore();
const offline = useOfflineStore();
const guard = useFormGuard();

const passkeys = ref<PasskeySummary[]>([]);
const devices = ref<QuickSignInSummary[]>([]);
const thisDevice = ref<LocalQuickSignIn | null>(null);

const passkeysSupported = ref(false);
const biometricOffered = ref(false);

const passkeyName = ref('');
const pin = ref('');
const pinAgain = ref('');
const showPinSetup = ref(false);

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const note = ref('');

const deviceLabel = computed(() => (isInstalled() ? 'This device' : 'This browser'));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    passkeysSupported.value = (await getPlatform().passkeys.availability()).supported;
    biometricOffered.value = await canOfferBiometric();
    thisDevice.value = localQuickSignIn();

    [passkeys.value, devices.value] = await Promise.all([
      api.listPasskeys(),
      api.listQuickSignIns(),
    ]);
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Could not load your sign-in options.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* -------------------------------------------------------------- passkeys */

function suggestedName(): string {
  return isInstalled() ? 'My phone' : 'My computer';
}

async function createPasskey(): Promise<void> {
  if (busy.value) return;
  const name = passkeyName.value.trim() === '' ? suggestedName() : passkeyName.value.trim();

  busy.value = true;
  error.value = '';
  note.value = '';
  try {
    if (await addPasskey(name)) {
      note.value = 'That passkey is set up. You can sign in with it from now on.';
      passkeyName.value = '';
      await load();
    }
    // Dismissing the prompt is a decision, not a failure, and says nothing.
  } catch (err) {
    error.value = passkeyMessage(err, 'That passkey could not be set up.');
  } finally {
    busy.value = false;
  }
}

/**
 * A `PasskeyError` already carries wording written for the person reading it,
 * so it is shown rather than replaced. Anything else gets the fallback.
 */
function passkeyMessage(err: unknown, fallback: string): string {
  if (err instanceof PasskeyError) return err.message;
  if (err instanceof ApiRequestError) return err.message;
  return fallback;
}

async function removePasskey(passkey: PasskeySummary): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.removePasskey(passkey.id);
    note.value = `${passkey.name} can no longer sign you in.`;
    await load();
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'That passkey could not be removed.';
  } finally {
    busy.value = false;
  }
}

/* --------------------------------------------------------- quick sign-in */

async function setUpBiometric(): Promise<void> {
  const user = session.principal;
  if (busy.value || !user) return;

  busy.value = true;
  error.value = '';
  note.value = '';
  try {
    if (!getPlatform().secureStore.isUnlocked()) {
      if (!(await offline.enrolBiometric(user.userId, user.displayName))) {
        error.value =
          'This device cannot use its fingerprint or face to protect the records. Set a PIN instead.';
        biometricOffered.value = false;
        return;
      }
    }

    thisDevice.value = await enableQuickSignIn('biometric', deviceLabel.value);
    note.value = 'Set up. Your fingerprint or face signs you in on this device now.';
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be set up.';
  } finally {
    busy.value = false;
  }
}

async function setUpPin(): Promise<void> {
  if (busy.value) return;
  if (
    !guard.ready(
      needsText('quick-pin', pin.value, 'Choose a PIN of at least six digits.'),
      needs('quick-pin', /^\d{6,}$/.test(pin.value), 'A PIN is six digits or more, numbers only.'),
      needs('quick-pin-again', pin.value === pinAgain.value, 'The two PINs do not match.'),
    )
  ) {
    return;
  }

  busy.value = true;
  error.value = '';
  note.value = '';
  try {
    if (!getPlatform().secureStore.isUnlocked()) await offline.enrolPin(pin.value);
    thisDevice.value = await enableQuickSignIn('pin', deviceLabel.value);
    note.value = 'Set up. That PIN signs you in on this device now.';
    pin.value = '';
    pinAgain.value = '';
    showPinSetup.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That PIN could not be set up.';
  } finally {
    busy.value = false;
  }
}

async function removeDevice(device: QuickSignInSummary): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.removeQuickSignIn(device.id);
    // Only this device holds the secret, so clearing it here is what actually
    // takes the button off the sign-in screen.
    if (thisDevice.value?.credentialId === device.id) {
      await forgetQuickSignIn();
      thisDevice.value = null;
    }
    note.value = `${device.label} can no longer sign you in without your password.`;
    await load();
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'That could not be removed.';
  } finally {
    busy.value = false;
  }
}

function formatWhen(iso: string | null): string {
  if (iso === null) return 'not used yet';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: session.timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <h1 class="text-2xl font-semibold">Signing in</h1>

    <FormError :message="guard.problem.value?.message ?? error" />
    <p v-if="note" class="text-text-secondary">{{ note }}</p>

    <p v-if="loading" class="text-text-secondary">Loading.</p>

    <template v-else>
      <section class="card space-y-3 p-4">
        <h2 class="text-lg font-semibold">Passkeys</h2>
        <p class="text-text-secondary text-sm">
          A passkey signs you in with the same fingerprint, face or screen lock you use on the
          device itself. It travels with you: one set up on your phone can sign you in on your
          computer too. It takes the place of your password and your authenticator code together.
        </p>

        <ul v-if="passkeys.length > 0" class="space-y-2">
          <li
            v-for="passkey in passkeys"
            :key="passkey.id"
            class="border-border-default flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <div>
              <p class="font-medium">{{ passkey.name }}</p>
              <p class="text-text-secondary text-sm">
                {{ describePasskey(passkey) }} · last used {{ formatWhen(passkey.lastUsedAt) }}
              </p>
            </div>
            <button
              type="button"
              class="btn border-border-default ml-auto border text-sm"
              :disabled="busy"
              @click="removePasskey(passkey)"
            >
              Remove
            </button>
          </li>
        </ul>

        <p v-else class="text-text-secondary text-sm">No passkeys yet.</p>

        <div v-if="passkeysSupported" class="flex flex-wrap items-end gap-3">
          <div class="min-w-48 flex-1">
            <label class="field-label" for="passkey-name">Name it</label>
            <input
              id="passkey-name"
              v-model="passkeyName"
              class="field"
              type="text"
              :placeholder="suggestedName()"
            />
          </div>
          <button type="button" class="btn btn-primary" :disabled="busy" @click="createPasskey">
            Add a passkey
          </button>
        </div>

        <p v-else class="text-text-secondary text-sm">
          This browser cannot use passkeys. A newer one, or your phone, can.
        </p>
      </section>

      <section class="card space-y-3 p-4">
        <h2 class="text-lg font-semibold">Quick sign-in on this device</h2>
        <p class="text-text-secondary text-sm">
          A PIN or your fingerprint, so you are not typing a password at the front door of every
          house. It works on this device only and it is not a second factor: it releases something
          this device already holds. Signing out clears it.
        </p>

        <p v-if="thisDevice" class="font-medium">
          Set up here with
          {{ thisDevice.method === 'biometric' ? 'fingerprint or face' : 'a PIN' }}.
        </p>

        <template v-else>
          <button
            v-if="biometricOffered"
            type="button"
            class="btn btn-primary"
            :disabled="busy"
            @click="setUpBiometric"
          >
            Use fingerprint or face
          </button>

          <p v-else class="text-text-secondary text-sm">
            <!--
              Not offered on a desktop and not in a browser tab (#24). A
              fingerprint on a machine four people share is the wrong offer even
              where it works, and a tab nobody closes is not a device.
            -->
            Fingerprint sign-in needs Vigilo installed on a phone or a tablet.
          </p>

          <button
            v-if="!showPinSetup"
            type="button"
            class="btn border-border-default border"
            @click="showPinSetup = true"
          >
            Set a PIN instead
          </button>

          <div v-else class="space-y-3">
            <div>
              <label class="field-label" for="quick-pin">PIN, at least six digits</label>
              <input
                id="quick-pin"
                v-model="pin"
                class="field max-w-48"
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                :aria-invalid="guard.invalid('quick-pin')"
              />
            </div>
            <div>
              <label class="field-label" for="quick-pin-again">PIN again</label>
              <input
                id="quick-pin-again"
                v-model="pinAgain"
                class="field max-w-48"
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                :aria-invalid="guard.invalid('quick-pin-again')"
              />
            </div>
            <button type="button" class="btn btn-primary" :disabled="busy" @click="setUpPin">
              Save this PIN
            </button>
          </div>
        </template>
      </section>

      <section v-if="devices.length > 0" class="card space-y-3 p-4">
        <h2 class="text-lg font-semibold">Devices that can sign in quickly</h2>
        <p class="text-text-secondary text-sm">
          Remove one you no longer have. It stops working straight away, and the password still
          works everywhere.
        </p>

        <ul class="space-y-2">
          <li
            v-for="device in devices"
            :key="device.id"
            class="border-border-default flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <div>
              <p class="font-medium">
                {{ device.label
                }}<span v-if="thisDevice?.credentialId === device.id"> (the one you are on)</span>
              </p>
              <p class="text-text-secondary text-sm">
                {{ device.method === 'biometric' ? 'Fingerprint or face' : 'PIN' }} · last used
                {{ formatWhen(device.lastUsedAt) }}
              </p>
            </div>
            <button
              type="button"
              class="btn border-border-default ml-auto border text-sm"
              :disabled="busy"
              @click="removeDevice(device)"
            >
              Remove
            </button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
