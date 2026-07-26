<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getClockSkewMs, getReady } from '@/api/client';
import { getPlatform, isInstalled } from '@/platform';
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
  biometricUnlock: false,
  push: 'unsupported' as string,
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
    biometricUnlock: await platform.secureStore.isAvailable(),
    push: platform.push.permission(),
  };
});

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">System</h1>

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
      <p class="text-text-secondary mt-1 text-sm">
        Reported through the platform adapters. The same screen will read the same way on the native
        builds.
      </p>
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
          <dt class="text-text-secondary">Biometric unlock</dt>
          <dd>{{ yesNo(capabilities.biometricUnlock) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-text-secondary">Push notifications</dt>
          <dd>{{ capabilities.push }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>
