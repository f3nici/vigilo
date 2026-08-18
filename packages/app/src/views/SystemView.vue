<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getClockSkewMs, getReady } from '@/api/client';
import { getPlatform, isInstalled, type UnlockMethod } from '@/platform';
import { isSkewSignificant, type ReadyResponse } from '@vigilo/shared';

/**
 * System status. Proves the SPA, the proxy, the API and Postgres are actually
 * talking to each other, and shows what this device can do before the offline
 * work in Phase 5 depends on it.
 */
const ready = ref<ReadyResponse | null>(null);
const reachable = ref<boolean | null>(null);
const skewMs = ref(0);

const platform = getPlatform();
const capabilities = ref({
  installed: isInstalled(),
  durableStorage: false,
  storagePersisted: false,
  /** Whether the hardware can do it, which is not whether anybody has set it up. */
  biometricAvailable: false,
  /** What this device actually unlocks with, which is the question being asked. */
  unlockMethod: null as UnlockMethod | null,
});

onMounted(async () => {
  try {
    ready.value = await getReady();
    reachable.value = true;
  } catch {
    reachable.value = false;
  }
  skewMs.value = getClockSkewMs();

  capabilities.value = {
    installed: isInstalled(),
    durableStorage: platform.storage.isAvailable(),
    storagePersisted: await platform.storage.isPersisted(),
    biometricAvailable: await platform.secureStore.isAvailable(),
    unlockMethod: await platform.secureStore.enrolledMethod(),
  };
});

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * The row used to read `isAvailable()`, so a device that merely has a
 * fingerprint reader claimed biometric unlock was on. It says what is set up
 * here, and separately whether the device could.
 */
function biometricState(): string {
  if (capabilities.value.unlockMethod === 'biometric') return 'Set up';
  return capabilities.value.biometricAvailable ? 'Available, not set up' : 'Not available';
}

function unlockState(): string {
  if (capabilities.value.unlockMethod === 'biometric') return 'Biometric';
  if (capabilities.value.unlockMethod === 'pin') return 'PIN';
  return 'Not set up';
}

/** Replaced at build time from the app's package.json. */
const appVersion = __APP_VERSION__;
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">System</h1>

    <!--
      What is running, in the words somebody would use reporting a problem.
      The app version is this build; the server build hash is below, and the two
      can legitimately differ for as long as a device has not taken an update.
    -->
    <section class="card p-4">
      <h2 class="text-lg font-semibold">Vigilo</h2>
      <dl class="mt-3 grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2">
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">App version</dt>
          <dd class="tabular" data-testid="app-version">{{ appVersion }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Made by</dt>
          <dd>
            <a
              class="text-primary underline"
              href="https://github.com/f3nici"
              target="_blank"
              rel="noopener noreferrer"
            >
              Fenici
            </a>
          </dd>
        </div>
      </dl>
    </section>

    <section class="card p-4">
      <h2 class="text-lg font-semibold">Server</h2>
      <dl class="mt-3 grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2">
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Reachable</dt>
          <dd data-testid="api-reachable">
            {{ reachable === null ? 'Checking' : yesNo(reachable) }}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Status</dt>
          <dd data-testid="api-status">{{ ready?.status ?? '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Database</dt>
          <dd>{{ ready ? yesNo(ready.checks.database) : '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Migrations current</dt>
          <dd>{{ ready ? yesNo(ready.checks.migrations) : '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Build</dt>
          <dd class="tabular">{{ ready?.build ?? '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Clock difference</dt>
          <dd class="tabular">
            {{ Math.round(skewMs / 1000) }}s
            <span v-if="isSkewSignificant(skewMs)" class="text-text-secondary"
              >(check the clock)</span
            >
          </dd>
        </div>
      </dl>
    </section>

    <section class="card p-4">
      <h2 class="text-lg font-semibold">This device</h2>
      <dl class="mt-3 grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2">
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Installed app</dt>
          <dd>{{ yesNo(capabilities.installed) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Durable local storage</dt>
          <dd>{{ yesNo(capabilities.durableStorage) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Storage marked persistent</dt>
          <dd>{{ yesNo(capabilities.storagePersisted) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Unlock on this device</dt>
          <dd>{{ unlockState() }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Biometric unlock</dt>
          <dd>{{ biometricState() }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>
