import { useEffect, useRef, useState } from 'react';
import { versionFromUrl, isNewerVersion, VERSION_CHECK_EVERY_MS, VERSION_CHECK_MIN_GAP_MS } from '../lib/appVersion.js';
import { useHasUnsavedChanges, hasUnsavedChanges, installUnsavedChangesTracking } from '../lib/unsavedChanges.js';

installUnsavedChangesTracking();

const RUNNING = versionFromUrl(import.meta.url);

// A small notice when a newer CRM version has been deployed than the one
// this tab is running. It never reloads on its own and never interrupts a
// form: staff choose when to press Reload, and are warned first if the page
// has unsaved changes. No database or record changes.
export default function NewVersionNotice() {
  const [available, setAvailable] = useState(false);
  const unsaved = useHasUnsavedChanges();
  const lastCheck = useRef(0);

  useEffect(() => {
    if (!RUNNING) return undefined; // development build: nothing to compare
    let stopped = false;
    async function check() {
      if (stopped || Date.now() - lastCheck.current < VERSION_CHECK_MIN_GAP_MS) return;
      lastCheck.current = Date.now();
      try {
        const res = await fetch('/api/version', { cache: 'no-store', credentials: 'include' });
        const { version } = await res.json();
        if (!stopped && isNewerVersion(RUNNING, version)) setAvailable(true);
      } catch {
        // Offline or a hiccup: just try again later.
      }
    }
    check();
    const timer = setInterval(check, VERSION_CHECK_EVERY_MS);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  if (!available) return null;
  function reload() {
    if (hasUnsavedChanges() && !window.confirm('You have unsaved changes on this page. Reloading now will discard them.\n\nReload anyway?')) return;
    window.location.reload();
  }
  return (
    <div
      role="status"
      data-testid="new-version-notice"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1000,
        maxWidth: 420,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'var(--surface, #fff)',
        border: '1px solid var(--border, #d0d7de)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600 }}>A new CRM version is available.</div>
      <div style={{ color: 'var(--ink-muted)', marginTop: 4 }} data-testid="new-version-unsaved">
        {unsaved
          ? 'You have unsaved changes on this page — save them first, or they will be lost when you reload.'
          : 'Reload when you are ready to get the latest changes.'}
      </div>
      <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={reload}>
        Reload
      </button>
    </div>
  );
}
