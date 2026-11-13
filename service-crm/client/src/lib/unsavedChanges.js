import { useEffect, useRef, useSyncExternalStore } from 'react';

// Unsaved staff changes anywhere in the CRM — so the "new version" notice
// can warn before a reload would discard them. Nothing is stored.
//
// Two layers:
// 1. App-wide: any text box, dropdown, date, checkbox or radio staff change
//    on ANY screen counts as unsaved while it still differs from its value
//    when they started editing it — until a save succeeds (any successful
//    non-GET request through lib/api.js, see markAllSaved). Filters, search
//    boxes, report screens and lookup tools are excluded by marking them
//    with data-unsaved-ignore (their values are remembered, not data).
// 2. Explicit: the two main entry forms also report their own state
//    (useUnsavedChangesTracker), cleared when they're loaded, reset or saved.

const IGNORE = '[data-unsaved-ignore]';
const dirty = new Set(); // explicit form keys
const originals = new WeakMap(); // element -> value when staff started editing it
const tracked = new Set(); // elements staff have changed
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

const SKIP_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'hidden', 'search', 'image']);
export function isTrackable(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  if (tag === 'INPUT' && SKIP_INPUT_TYPES.has(String(el.type || '').toLowerCase())) return false;
  if (el.disabled || el.readOnly) return false;
  if (typeof el.closest === 'function' && el.closest(IGNORE)) return false;
  return true;
}
const valueOf = (el) => {
  const t = String(el.type || '').toLowerCase();
  return t === 'checkbox' || t === 'radio' ? String(!!el.checked) : String(el.value ?? '');
};
const CHANGED = Symbol('changed before its starting value was seen');

function remember(el) {
  if (isTrackable(el) && !originals.has(el)) originals.set(el, valueOf(el));
}
function changed(el) {
  if (!isTrackable(el)) return;
  if (!originals.has(el)) originals.set(el, CHANGED);
  tracked.add(el);
  emit();
}

let installed = false;
export function installUnsavedChangesTracking(doc = typeof document !== 'undefined' ? document : null) {
  if (installed || !doc) return;
  installed = true;
  // Remember a field's value before staff change it (focus, click or key).
  for (const ev of ['focusin', 'pointerdown', 'keydown']) doc.addEventListener(ev, (e) => remember(e.target), true);
  for (const ev of ['input', 'change']) doc.addEventListener(ev, (e) => changed(e.target), true);
}

export function setUnsaved(key, isDirty) {
  const had = dirty.has(key);
  if (isDirty && !had) dirty.add(key);
  else if (!isDirty && had) dirty.delete(key);
  else return;
  emit();
}

export function hasUnsavedChanges() {
  if (dirty.size > 0) return true;
  for (const el of tracked) {
    if (!el.isConnected) {
      tracked.delete(el); // that screen or form is gone
      continue;
    }
    const was = originals.get(el);
    if (was === CHANGED || was !== valueOf(el)) return true;
  }
  return false;
}

/** A save succeeded: what's on screen now is the saved state. */
export function markAllSaved() {
  for (const el of tracked) if (el.isConnected) originals.set(el, valueOf(el));
  tracked.clear();
  emit();
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useHasUnsavedChanges() {
  return useSyncExternalStore(subscribe, hasUnsavedChanges);
}

/** For a form: `markDirty` on staff input, `markClean` when it's loaded,
 * reset or saved. Cleared when the form unmounts. */
export function useUnsavedChangesTracker(key) {
  const keyRef = useRef(key);
  useEffect(() => () => setUnsaved(keyRef.current, false), []);
  return {
    markDirty: () => setUnsaved(keyRef.current, true),
    markClean: () => setUnsaved(keyRef.current, false),
  };
}
