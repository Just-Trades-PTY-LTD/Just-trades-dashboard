import { useState } from 'react';

/** Drop-in replacement for useState() that also persists to sessionStorage,
 * so a browser refresh restores the same value instead of resetting to the
 * default — scoped to this browser tab only (closing it clears it, same as
 * any other session-only state). Used for "which tab/sub-tab is active", not
 * for any saved CRM data itself. */
export function useSessionState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  function setAndStore(next) {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      try {
        sessionStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Ignore storage failures (private browsing, quota, etc.) — the tab
        // just won't be remembered across a refresh, nothing else breaks.
      }
      return resolved;
    });
  }

  return [value, setAndStore];
}
