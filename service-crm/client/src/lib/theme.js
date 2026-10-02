import { useEffect, useState } from 'react';

// A manual theme override — a per-browser display preference, not CRM data.
// Defaults to "system" (follow the OS/browser's own light/dark setting, via
// styles.css's `prefers-color-scheme` media query, unchanged); choosing
// "light" or "dark" instead pins the app to that theme regardless of the
// system setting. Stored in localStorage (not sessionStorage) so the choice
// survives closing and reopening the browser, and applied via a data-theme
// attribute on <html> — see the two `[data-theme=...]` rules in styles.css.
//
// index.html runs a tiny inline copy of the read-and-apply step below,
// before this module (or React) loads, purely so the correct theme is set
// before first paint instead of flashing the wrong one for a moment. Keep
// the storage key and the valid values in sync with that script if either
// ever changes.
export const THEME_STORAGE_KEY = 'crm.theme';
export const THEME_OPTIONS = ['system', 'light', 'dark'];

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState(readStoredTheme);

  // Re-applies on every change, including the initial one — harmless if
  // index.html's inline copy already set the same attribute, and this is
  // the only place a later change (from the Settings toggle) ever applies.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function setTheme(next) {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (private browsing, quota, etc.) — the
      // choice just won't survive a refresh, nothing else breaks.
    }
  }

  return [theme, setTheme];
}
