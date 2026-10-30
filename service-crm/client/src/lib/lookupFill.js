// Auto-fill from a Job Number lookup that follows the Job Number.
//
// Before: a lookup only ever filled BLANK fields and never took back what it
// had filled, so correcting a mistyped Job Number left the first job's
// technician / trade / job type / suburb in place (the right job's values
// couldn't get into the now-filled fields) — e.g. a sale credited to the
// wrong technician.
//
// Now each lookup source remembers what it filled. When its result changes
// (a new Job Number, no match, or no Job Number at all), a field it filled
// is cleared again ONLY if it still holds exactly that value — anything
// staff typed or picked themselves, anything another lookup filled, and
// anything loaded from a saved record is never touched. Then blank fields
// are filled from the new result, the same as before.
//
//   form      - the form as it is now
//   previous  - { field: value } this source filled last time
//   wanted    - { field: value } this source would fill now ({} if no match)
//
// Returns { patch, filled }: the changes to apply, and what this source has
// now filled (to pass back in as `previous` next time).
export function nextLookupFill(form, previous, wanted) {
  const patch = {};
  Object.entries(previous || {}).forEach(([field, value]) => {
    if (form[field] === value && wanted?.[field] !== value) patch[field] = '';
  });
  const filled = {};
  Object.entries(wanted || {}).forEach(([field, value]) => {
    if (value === undefined || value === null || value === '') return;
    const current = field in patch ? patch[field] : form[field];
    if (current === value && previous?.[field] === value) {
      filled[field] = value; // still showing what this source filled
    } else if (!current) {
      patch[field] = value;
      filled[field] = value;
    }
  });
  return { patch, filled };
}
