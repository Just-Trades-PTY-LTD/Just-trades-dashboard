import { useEffect, useRef, useSyncExternalStore } from 'react';

// Which open forms have unsaved staff changes — so the "new version" notice
// can warn before a reload would discard them. A form is "unsaved" once
// staff type or change a field (input/change events) after it was loaded,
// reset or saved; automatic fills alone don't count. Nothing is stored.
const dirty = new Set();
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

export function setUnsaved(key, isDirty) {
  const had = dirty.has(key);
  if (isDirty && !had) dirty.add(key);
  else if (!isDirty && had) dirty.delete(key);
  else return;
  emit();
}
export function hasUnsavedChanges() {
  return dirty.size > 0;
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
