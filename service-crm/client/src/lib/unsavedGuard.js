import { useEffect, useRef } from 'react';

// A tiny, app-wide "is there a dirty form open right now, and what should
// leaving it without saving confirm with?" slot. A form registers itself
// here for as long as it's mounted (via useUnsavedFormGuard below); a
// navigation action elsewhere in the app that doesn't go through that form's
// own Cancel/Save buttons — switching the top-level tab, closing or
// refreshing the browser tab — asks confirmLeave() first. Only one form is
// ever open at a time in this app, so a single slot (rather than a list) is
// enough, and unmounting always clears it, so a stale guard from a page
// that's no longer showing can never block navigation elsewhere.
let activeGuard = null;

export function confirmLeave() {
  if (!activeGuard || !activeGuard.isDirty()) return true;
  const leaving = window.confirm(activeGuard.message);
  // Confirmed leaving a dirty form (rather than saving or cancelling it
  // through its own buttons) still counts as abandoning it — give the form
  // a chance to reset its host page's state (e.g. back to a list view) so
  // returning to this page later doesn't resurface the same stale form.
  if (leaving) activeGuard.onLeave?.();
  return leaving;
}

// `isDirty` is read fresh (via a ref) every time confirmLeave() or the
// browser's beforeunload fires, so the caller just passes its current dirty
// boolean on every render — no need to memoize it. `onLeave` is likewise
// read fresh, and is optional — only a host page that needs to reset its own
// navigation state on an overridden leave (see Calls/index.jsx) passes one.
export function useUnsavedFormGuard(isDirty, message = 'You have unsaved changes. Leave without saving?', onLeave) {
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    const guard = { isDirty: () => isDirtyRef.current, message, onLeave: () => onLeaveRef.current?.() };
    activeGuard = guard;
    function onBeforeUnload(e) {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Only clear the slot if nothing re-registered over it in the meantime
      // (e.g. React briefly mounting a second instance during a transition).
      if (activeGuard === guard) activeGuard = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
