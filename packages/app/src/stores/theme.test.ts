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
  document.documentElement.classList.remove('dark');
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
