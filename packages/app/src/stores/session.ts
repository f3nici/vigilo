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
      forget();
      loaded.value = true;
      return;
    }

    try {
      const me = await api.getMe();
      principal.value = me.principal;
      scope.value = me.scope;
      org.value = me.org;
      remember(me);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'unauthenticated') {
        principal.value = null;
        scope.value = null;
        org.value = null;
        forget();
      } else if (error instanceof ApiRequestError) {
        throw error;
      } else {
        /*
         * No signal.
         *
         * The session is still valid; we simply cannot ask about it right now.
         * Throwing here leaves the router guard unresolved and the app renders
         * nothing, which is a blank screen for a worker standing in a house
         * with no reception, holding a phone that has every record they need
         * already on it. So the last known principal stands until the server
         * says otherwise (doc 06 §7: offline is normal, not an error).
         */
        const cached = recall();
        if (cached && principal.value === null) {
          principal.value = cached.principal;
          scope.value = cached.scope;
          org.value = cached.org;
        }
      }
    } finally {
      loaded.value = true;
    }
  }

  /**
   * The last known principal, so a cold start with no signal knows who is
   * holding the phone.
   *
   * A display name, a role and the org's name and timezone. No participant
   * data: that lives in the local database, encrypted, behind the unlock. This
   * much is on screen anyway to whoever has the device in their hand.
   */
  const CACHE_KEY = 'vigilo.session';

  function remember(me: MeResponse): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(me));
    } catch {
      // Private mode. The app still works, it just cannot start offline.
    }
  }

  function recall(): MeResponse | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw === null ? null : (JSON.parse(raw) as MeResponse);
    } catch {
      return null;
    }
  }

  function forget(): void {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Nothing to do, and nothing that should stop a sign-out.
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
      forget();
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
