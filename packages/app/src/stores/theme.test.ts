import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThemeStore } from './theme.js';

function stubPrefersDark(dark: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: dark,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.classList.remove('dark', 'contrast');
});

describe('theme store', () => {
  it('follows the device setting by default', () => {
    stubPrefersDark(true);
    const theme = useThemeStore();
    theme.apply();
    expect(theme.preference).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('lets a manual override win over the device setting', () => {
    stubPrefersDark(true);
    const theme = useThemeStore();
    theme.setPreference('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('vigilo.theme')).toBe('light');
  });

  it('clears the override when returning to system', () => {
    stubPrefersDark(false);
    const theme = useThemeStore();
    theme.setPreference('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    theme.setPreference('system');
    expect(localStorage.getItem('vigilo.theme')).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('high contrast', () => {
  it('is off by default', () => {
    stubPrefersDark(false);
    const theme = useThemeStore();
    theme.apply();
    expect(theme.contrast).toBe('normal');
    expect(document.documentElement.classList.contains('contrast')).toBe(false);
  });

  it('is a separate axis from light and dark', () => {
    // Somebody who needs more contrast needs it at 2am as well as at noon.
    stubPrefersDark(false);
    const theme = useThemeStore();
    theme.setContrast('high');
    theme.setPreference('dark');

    expect(document.documentElement.classList.contains('contrast')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('vigilo.contrast')).toBe('high');
  });

  it('forgets the preference when turned off', () => {
    stubPrefersDark(false);
    const theme = useThemeStore();
    theme.setContrast('high');
    theme.setContrast('normal');

    expect(localStorage.getItem('vigilo.contrast')).toBeNull();
    expect(document.documentElement.classList.contains('contrast')).toBe(false);
  });
});
