// Shared formatting for the {field: {from, to}} diffs recordAudit() writes —
// used by the per-record "History" views and the admin Activity history page.
// `|| '—'` alone would misrender any falsy-but-real value (0, false) as
// blank, which matters now that creation events log fields like `knockback`
// or `follow_up` that are legitimately 0.
function displayValue(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

// Keys the archive / linked-edit actions record (see server/src/lib/archive.js
// and routes/techSales.js). Each holds the id of the linked record in `to`
// (or `from` for converted_by_sale), so it reads as a sentence, not a diff.
const LINK_LABELS = {
  linked_sale_archived: (ch) => `also archived its linked sale #${ch.to}`,
  linked_sale_restored: (ch) => `also restored its linked sale #${ch.to}`,
  archived_with_job: (ch) => `archived together with job #${ch.to}`,
  restored_with_job: (ch) => `restored together with job #${ch.to}`,
  archived_with_call: (ch) => `archived together with call #${ch.to}`,
  restored_with_call: (ch) => `restored together with call #${ch.to}`,
  conversion_reversed_for_job: (ch) => `"Converted later" removed from job #${ch.to}`,
  conversion_linked_to_job: (ch) => `linked to its original knock-back job #${ch.to}`,
  stored_knockback_flag: (ch) => `stored knock-back flag corrected (${ch.from} → ${ch.to})`,
  conversion_reapplied_for_job: (ch) => `"Converted later" re-applied to job #${ch.to}`,
  converted_by_sale: (ch) =>
    ch.to ? `converted by Quote Approved Later sale #${ch.to}` : `no longer converted by Quote Approved Later sale #${ch.from}`,
};

export function formatAuditChanges(changes) {
  const entries = Object.entries(changes || {});
  if (!entries.length) return '—';
  return entries
    .map(([field, ch]) => (LINK_LABELS[field] ? LINK_LABELS[field](ch) : `${field} (${displayValue(ch.from)} → ${displayValue(ch.to)})`))
    .join(', ');
}
