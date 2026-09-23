import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const SECTION_SIZES = ['sm', 'md', 'lg'];

const SAVE_DEBOUNCE_MS = 400;

// Loads and saves one report's section layout (each section's size and
// collapsed state) for the signed-in user. Purely a display preference —
// scoped server-side to the current user, so it never touches any CRM record
// and never affects any other user's saved layout.
export function useReportLayout(reportKey) {
  const [layout, setLayout] = useState({});
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.reports
      .getLayouts()
      .then((all) => {
        if (cancelled) return;
        setLayout((all && all[reportKey]) || {});
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [reportKey]);

  function persist(next) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.reports.saveLayout(reportKey, next).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  function update(sectionId, patch) {
    setLayout((prev) => {
      const next = { ...prev, [sectionId]: { ...prev[sectionId], ...patch } };
      persist(next);
      return next;
    });
  }

  function get(sectionId, defaultSize) {
    const entry = layout[sectionId];
    return { size: entry?.size || defaultSize, collapsed: !!entry?.collapsed };
  }

  return {
    loaded,
    get,
    setSize: (sectionId, size) => update(sectionId, { size }),
    setCollapsed: (sectionId, collapsed) => update(sectionId, { collapsed }),
  };
}
