import { useState } from 'react';
import { useSessionState } from './useSessionState.js';

// Splits a report's filter bar into "draft" (what's currently in the date/
// staff/technician/trade inputs) and "applied" (what the report, its
// charts/tables/drill-downs, and its Excel export link actually use) — so
// editing a date doesn't refetch on every keystroke; nothing changes until
// Refresh Report is clicked (and validated) or Reset Filters is used.
// `defaults` is called fresh every time a current default is needed, so
// "the current week" always means the week right now, not whatever it was
// when the report first mounted.
//
// `storageKey` persists draft/applied to sessionStorage (same mechanism as
// which tab is active), so navigating away to another view and back —
// including via the browser's Back button — restores the same dates and
// filters instead of resetting to the current week.
export function useReportFilters(defaults, storageKey) {
  const [draft, setDraft] = useSessionState(`${storageKey}.draft`, defaults);
  const [applied, setApplied] = useSessionState(`${storageKey}.applied`, defaults);
  const [error, setError] = useState('');

  function patch(p) {
    setDraft((d) => ({ ...d, ...p }));
  }

  function validate(f) {
    if (f.from && f.to && f.from > f.to) {
      return 'The "From" date must be on or before the "To" date.';
    }
    return '';
  }

  // Returns whether it actually applied — the caller uses this to decide
  // whether to also show a loading state.
  function refresh() {
    const err = validate(draft);
    if (err) {
      setError(err);
      return false;
    }
    setError('');
    setApplied({ ...draft });
    return true;
  }

  function reset() {
    const next = defaults();
    setDraft(next);
    setApplied(next);
    setError('');
    return next;
  }

  return { draft, applied, patch, error, refresh, reset };
}
