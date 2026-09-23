// Shared formatting for the {field: {from, to}} diffs recordAudit() writes —
// used by the per-record "History" views and the admin Activity history page.
// `|| '—'` alone would misrender any falsy-but-real value (0, false) as
// blank, which matters now that creation events log fields like `knockback`
// or `follow_up` that are legitimately 0.
function displayValue(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

export function formatAuditChanges(changes) {
  const entries = Object.entries(changes || {});
  if (!entries.length) return '—';
  return entries.map(([field, ch]) => `${field} (${displayValue(ch.from)} → ${displayValue(ch.to)})`).join(', ');
}
