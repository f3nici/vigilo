import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'vigilo.theme';

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function read(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private mode. Fall back to the device setting.
  }
  return 'system';
}

/**
 * Follow the device setting with a manual override (doc 08 §3). The initial
 * class is applied by an inline script in index.html so there is no white
 * flash before Vue mounts.
 */
export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>(read());
  const isDark = ref(
    preference.value === 'dark' || (preference.value === 'system' && prefersDark()),
  );

  function apply(): void {
    isDark.value = preference.value === 'dark' || (preference.value === 'system' && prefersDark());
    document.documentElement.classList.toggle('dark', isDark.value);
  }

  function setPreference(next: ThemePreference): void {
    preference.value = next;
    try {
      if (next === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Preference is not persisted in private mode. It still applies now.
    }
    apply();
  }

  function watchSystem(): void {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (preference.value === 'system') apply();
    });
  }

  return { preference, isDark, apply, setPreference, watchSystem };
});
