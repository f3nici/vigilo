import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { isInstalled } from '@/platform';

/**
 * Phase 0 session shell.
 *
 * There is no identity in the system yet: users, roles, passwords, TOTP and
 * the scope resolver are Phase 1. This store exists so the router guard, the
 * shell layout and the two auth models have somewhere to land, and it holds
 * nothing but the auth mode the client should use.
 *
 * `signIn` deliberately does not exist. Nothing in Phase 0 can authenticate
 * anyone, and a placeholder that appears to would be worse than an empty one.
 */
export type AuthModel = 'session-cookie' | 'refresh-token';

export const useSessionStore = defineStore('session', () => {
  /**
   * A browser tab gets the office experience, an installed app gets the field
   * experience. Decided once at startup from display mode (doc 02 §5).
   */
  const authModel = ref<AuthModel>(isInstalled() ? 'refresh-token' : 'session-cookie');

  /** Always false until Phase 1 issues real credentials. */
  const principal = ref<null>(null);
  const isAuthenticated = computed(() => principal.value !== null);

  return { authModel, principal, isAuthenticated };
});
