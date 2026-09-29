import { useState } from 'react';

// Like useSessionState, but persistence can be switched off entirely
// (`disabled`) — used for a report drill-down's embedded, filter-less list
// view, which must never inherit, or overwrite, the filters the user has set
// on that record type's own full history screen.
export function usePersistentFilters(key, emptyFn, disabled) {
  const [value, setValue] = useState(() => {
    if (disabled) return emptyFn();
    try {
      const stored = sessionStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : emptyFn();
    } catch {
      return emptyFn();
    }
  });

  function setAndStore(next) {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (!disabled) {
        try {
          sessionStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Ignore storage failures (private browsing, quota, etc).
        }
      }
      return resolved;
    });
  }

  return [value, setAndStore];
}
