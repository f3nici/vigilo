import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { MeResponse, Principal } from '@vigilo/shared';
import { isInstalled } from '@/platform';
import * as api from '@/api/client';
import { ApiRequestError } from '@/api/client';

/**
 * Who is signed in, and what they still have to do before they can work.
 *
 * A browser tab uses the office session cookie; an installed app will use the
 * rotating refresh token from Phase 5, when the secure store adapter has a
 * body. Which model applies is decided once at startup from display mode
 * (doc 02 §5).
 */
export type AuthModel = 'session-cookie' | 'refresh-token';

export type PendingStep = 'password' | 'totp' | null;

export const useSessionStore = defineStore('session', () => {
  const authModel = ref<AuthModel>(isInstalled() ? 'refresh-token' : 'session-cookie');

  const principal = ref<Principal | null>(null);
  const scope = ref<MeResponse['scope'] | null>(null);
  const org = ref<MeResponse['org'] | null>(null);
  const loaded = ref(false);

  const isAuthenticated = computed(() => principal.value !== null);

  /**
   * What the user must resolve before anything else is allowed. The API
   * enforces this too; this is so the UI takes them there rather than showing
   * a wall of errors.
   */
  const pendingStep = computed<PendingStep>(() => {
    const me = principal.value;
    if (!me) return null;
    if (me.mustChangePassword) return 'password';
    if (me.totpRequired && !me.totpEnabled) return 'totp';
    return null;
  });

  /**
   * The session cookie is httpOnly, so the app cannot see it. The CSRF cookie
   * is set alongside it and is readable, which makes it a reliable hint that a
   * session may exist. Without this, every cold load of a signed-out browser
   * fires a request that can only 401.
   */
  function mayHaveSession(): boolean {
    if (authModel.value === 'refresh-token') return true;
    return /(?:^|;\s*)vigilo_csrf=/.test(document.cookie);
  }

  async function refresh(): Promise<void> {
    if (!mayHaveSession()) {
      principal.value = null;
      scope.value = null;
      org.value = null;
      loaded.value = true;
      return;
    }

    try {
      const me = await api.getMe();
      principal.value = me.principal;
      scope.value = me.scope;
      org.value = me.org;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'unauthenticated') {
        principal.value = null;
        scope.value = null;
        org.value = null;
      } else {
        throw error;
      }
    } finally {
      loaded.value = true;
    }
  }

  /** Called once at startup so a reload does not bounce a signed-in user out. */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    await refresh();
  }

  async function signOut(): Promise<void> {
    try {
      await api.logout();
    } finally {
      principal.value = null;
      scope.value = null;
      org.value = null;
    }
  }

  return {
    authModel,
    principal,
    scope,
    org,
    loaded,
    isAuthenticated,
    pendingStep,
    refresh,
    ensureLoaded,
    signOut,
  };
});
