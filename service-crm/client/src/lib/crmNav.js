import { useCallback, useEffect, useRef, useState } from 'react';

// Every navigable "view" in the CRM (which top tab, which sub-tab, which
// record is being edited, which report drill-down is open) lives together in
// one small, serialisable object. That object is pushed into the browser's
// native History API, so the browser's own Back/Forward buttons walk through
// it directly — without ever reloading the page, touching the login session,
// or re-running a save. One instance of useCrmNav() lives at the top of
// App.jsx; `nav` and `updateNav` are threaded down through props, the same
// way this app already threads jumpToJN/pendingJump/clearJump.
//
// Nothing here stores or changes any saved CRM record — it only remembers
// which screen was showing.

const LEGACY_KEYS = {
  module: 'crm.module',
  callsSub: 'crm.calls.sub',
  techSub: 'crm.tech.sub',
  reportsSub: 'crm.reports.sub',
  settingsSub: 'crm.settings.sub',
};

function readLegacy(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// The floor of the navigation stack — what Back shows once every other
// internal view has been walked back through. Also what a brand new tab (no
// history yet) starts from, seeded from the legacy per-tab/sub-tab memory so
// a plain refresh still lands where it used to.
function defaultNav() {
  return {
    module: readLegacy(LEGACY_KEYS.module, 'home'),
    pendingJump: null,
    calls: { sub: readLegacy(LEGACY_KEYS.callsSub, 'log'), editing: null },
    tech: { sub: readLegacy(LEGACY_KEYS.techSub, 'log'), editing: null },
    reports: { sub: readLegacy(LEGACY_KEYS.reportsSub, 'calls'), callsDrilldown: null, techDrilldown: null },
    settings: { sub: readLegacy(LEGACY_KEYS.settingsSub, 'lists') },
  };
}

function isNavShape(v) {
  return !!v && typeof v === 'object' && typeof v.module === 'string' && v.calls && v.tech && v.reports && v.settings;
}

// Best-effort only — Back/Forward already works from the history entry
// itself; this just keeps a plain refresh in a brand new tab (no history bar
// state at all yet) landing on the same tab/sub-tab as before, matching the
// behaviour this app already had.
function saveLegacy(nav) {
  try {
    sessionStorage.setItem(LEGACY_KEYS.module, JSON.stringify(nav.module));
    sessionStorage.setItem(LEGACY_KEYS.callsSub, JSON.stringify(nav.calls.sub));
    sessionStorage.setItem(LEGACY_KEYS.techSub, JSON.stringify(nav.tech.sub));
    sessionStorage.setItem(LEGACY_KEYS.reportsSub, JSON.stringify(nav.reports.sub));
    sessionStorage.setItem(LEGACY_KEYS.settingsSub, JSON.stringify(nav.settings.sub));
  } catch {
    // Ignore storage failures (private browsing, quota, etc).
  }
}

export function useCrmNav() {
  const initialRef = useRef(null);
  if (initialRef.current === null) {
    initialRef.current = isNavShape(window.history.state) ? window.history.state : defaultNav();
  }
  const [nav, setNav] = useState(initialRef.current);
  // The single source of truth updateNav/onPopState read "prev" from —
  // updated ONLY by those two places, never re-derived from initialRef on a
  // later render, or every navigation after the first would revert to the
  // very first snapshot the app ever had.
  const navRef = useRef(initialRef.current);

  useEffect(() => {
    if (!isNavShape(window.history.state)) {
      // First load in this tab (or a state the browser lost, e.g. private
      // browsing) — plant a floor entry so the very first Back has
      // somewhere real inside the CRM to land on, instead of leaving it.
      window.history.replaceState(initialRef.current, '', window.location.href);
    }
    function onPopState(e) {
      const next = isNavShape(e.state) ? e.state : defaultNav();
      navRef.current = next;
      setNav(next);
      saveLegacy(next);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // `push: true` (default) creates a new Back-stop — use it for opening a
  // record, a drill-down, or switching a tab/sub-tab. `push: false` amends
  // the *current* entry instead — use it only for a follow-up patch that's
  // part of the same logical navigation action (see jumpToJN's consumers),
  // so one user click never produces two Back-stops.
  const updateNav = useCallback((updater, { push = true } = {}) => {
    const prev = navRef.current;
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
    if (JSON.stringify(next) === JSON.stringify(prev)) return; // no-op click (e.g. re-clicking the active tab)
    navRef.current = next;
    setNav(next);
    saveLegacy(next);
    if (push) window.history.pushState(next, '', window.location.href);
    else window.history.replaceState(next, '', window.location.href);
  }, []);

  return [nav, updateNav];
}

// Small helper for App.jsx: builds a setter for one field of one top-level
// nav slice (e.g. makeSliceSetter(updateNav, 'calls', 'sub')), so each page
// gets a plain (value, opts) => void function instead of needing to know the
// shape of the whole nav tree.
export function makeSliceSetter(updateNav, sliceKey, field) {
  return (value, opts) => updateNav((prev) => ({ ...prev, [sliceKey]: { ...prev[sliceKey], [field]: value } }), opts);
}
