// What a "Look up in AroFlo" result is allowed to put straight into the form.
//
// A brand-new entry: Suburb (where the entry type has one) is applied on a
// confident match, and Comments only if still blank — nothing is saved until
// staff log the entry.
//
// Editing an entry that's already saved: nothing is applied. Clicking
// Update would otherwise quietly change a saved record (and reports such as
// Revenue by Suburb), so the form shows AroFlo's values as suggestions
// instead and only changes a field when staff click "Use this".
export function arofloAutoFill({ result, form, applySuburb, editing }) {
  if (!result?.found || editing) return {};
  const fill = {};
  if (applySuburb && result.suburb) fill.suburb = result.suburb;
  if (result.description && !form.comments) fill.comments = result.description;
  return fill;
}

// While editing: AroFlo's suburb, when it differs from what the form holds.
export function arofloSuburbSuggestion({ result, form, editing }) {
  if (!editing || !result?.found || !result.suburb) return null;
  return form.suburb === result.suburb ? null : result.suburb;
}

// While editing: AroFlo's description, only when Comments is still blank —
// same "never replace what's already there" rule as a new entry.
export function arofloCommentsSuggestion({ result, form, editing }) {
  if (!editing || !result?.found || !result.description || form.comments) return null;
  return result.description;
}
