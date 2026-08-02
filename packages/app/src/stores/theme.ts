import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Doc 06 §7 asks for a high-contrast mode. It is a separate axis from light
 * and dark, not a fourth theme: somebody who needs more contrast needs it at
 * 2am as well as at noon.
 */
export type ContrastPreference = 'normal' | 'high';

const STORAGE_KEY = 'vigilo.theme';
const CONTRAST_KEY = 'vigilo.contrast';

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

function readContrast(): ContrastPreference {
  try {
    if (localStorage.getItem(CONTRAST_KEY) === 'high') return 'high';
  } catch {
    // Private mode again. Normal contrast, and the toggle still works.
  }
  return 'normal';
}

/**
 * Follow the device setting with a manual override (doc 08 §3). The initial
 * class is applied by an inline script in index.html so there is no white
 * flash before Vue mounts.
 */
export const useThemeStore = defineStore('theme', () => {
  const preference = ref<ThemePreference>(read());
  const contrast = ref<ContrastPreference>(readContrast());
  const isDark = ref(
    preference.value === 'dark' || (preference.value === 'system' && prefersDark()),
  );

  function apply(): void {
    isDark.value = preference.value === 'dark' || (preference.value === 'system' && prefersDark());
    document.documentElement.classList.toggle('dark', isDark.value);
    document.documentElement.classList.toggle('contrast', contrast.value === 'high');
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

  function setContrast(next: ContrastPreference): void {
    contrast.value = next;
    try {
      if (next === 'normal') {
        localStorage.removeItem(CONTRAST_KEY);
      } else {
        localStorage.setItem(CONTRAST_KEY, next);
      }
    } catch {
      // Not persisted in private mode. It still applies now.
    }
    apply();
  }

  function watchSystem(): void {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (preference.value === 'system') apply();
    });
  }

  return { preference, contrast, isDark, apply, setPreference, setContrast, watchSystem };
});
