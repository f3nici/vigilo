<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { checkPassword, passwordProblemMessages, MIN_PASSWORD_LENGTH } from '@vigilo/shared';
import VigiloMark from '@/components/VigiloMark.vue';
import FormError from '@/components/FormError.vue';
import { useSessionStore } from '@/stores/session';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';
import { needs, needsText, useFormGuard } from '@/lib/forms';

const session = useSessionStore();
const router = useRouter();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const busy = ref(false);

/**
 * The same rules the server applies, from @vigilo/shared, so the feedback here
 * cannot drift from what the request will accept.
 */
const problems = computed(() =>
  newPassword.value === ''
    ? []
    : checkPassword({
        password: newPassword.value,
        email: session.principal?.email,
        currentPassword: currentPassword.value || undefined,
      }),
);

const mismatch = computed(
  () => confirmPassword.value !== '' && confirmPassword.value !== newPassword.value,
);

/**
 * What still has to be answered, in the order the fields appear. The button is
 * never greyed out for any of it: pressing it says which one and points there.
 */
const guard = useFormGuard();

const checks = () => [
  needsText('current', currentPassword.value, 'Type the password you were given.'),
  needsText('new', newPassword.value, 'Choose a new password.'),
  // The list under the field already spells each one out. This names the field.
  needs('new', problems.value.length === 0, 'That password does not meet the rules below it.'),
  needs('confirm', !mismatch.value, 'The two new passwords do not match.'),
];

async function submit(): Promise<void> {
  if (busy.value || !guard.ready(...checks())) return;
  busy.value = true;
  error.value = '';
  try {
    await api.changePassword(currentPassword.value, newPassword.value);

    // Changing a password signs every session out, including this one, so the
    // only honest next step is signing in again. Clear the stale principal
    // first: navigating on it would let the guard send us straight back here.
    await session.refresh();
    await router.push({ name: 'sign-in' });
  } catch (err) {
    error.value =
      err instanceof ApiRequestError
        ? err.message
        : 'Could not reach the server. Check your connection and try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-8">
    <div class="text-primary flex items-center gap-3">
      <VigiloMark :size="40" />
      <span class="text-text text-2xl font-semibold tracking-tight">Vigilo</span>
    </div>

    <form class="card space-y-4 p-6" @submit.prevent="submit">
      <h1 class="text-lg font-semibold">Choose a new password</h1>
      <p class="text-text-secondary text-sm">
        Your account was set up with a password someone handed you, so it has to change before you
        can use Vigilo. Use at least {{ MIN_PASSWORD_LENGTH }} characters.
      </p>

      <FormError :message="guard.problem.value?.message ?? error" />

      <div>
        <label class="field-label" for="current">Current password</label>
        <input
          id="current"
          v-model="currentPassword"
          class="field"
          type="password"
          autocomplete="current-password"
          :disabled="busy"
          :aria-invalid="guard.invalid('current')"
          @input="guard.clear()"
        />
      </div>

      <div>
        <label class="field-label" for="new">New password</label>
        <input
          id="new"
          v-model="newPassword"
          class="field"
          type="password"
          autocomplete="new-password"
          :disabled="busy"
          :aria-invalid="guard.invalid('new')"
          @input="guard.clear()"
        />
        <ul v-if="problems.length" class="mt-2 space-y-1 text-sm">
          <li v-for="problem in problems" :key="problem" :style="{ color: 'var(--vigilo-missed)' }">
            {{ passwordProblemMessages[problem] }}
          </li>
        </ul>
      </div>

      <div>
        <label class="field-label" for="confirm">New password again</label>
        <input
          id="confirm"
          v-model="confirmPassword"
          class="field"
          type="password"
          autocomplete="new-password"
          :disabled="busy"
          :aria-invalid="guard.invalid('confirm')"
          @input="guard.clear()"
        />
        <p v-if="mismatch" class="mt-2 text-sm" :style="{ color: 'var(--vigilo-missed)' }">
          The two passwords do not match.
        </p>
      </div>

      <button class="btn btn-primary w-full" type="submit" :disabled="busy">
        {{ busy ? 'Saving' : 'Save and sign in again' }}
      </button>
    </form>
  </div>
</template>
