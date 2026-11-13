import { all } from '../db/index.js';

// Readable Activity History — DISPLAY ONLY. Turns the stored
// {field: {from, to}} diffs into sentences like "Trade: Plumbing → Electrical".
// Nothing stored is read for writing or rewritten: names are looked up as the
// history is shown (so they're the names as they are NOW), and a linked item
// that has since been deleted shows as e.g. "Deleted technician (ID 2)".

const blank = (v) => v === null || v === undefined || v === '';
const DASH = '—';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
};
export const money = (n) =>
  `$${(Math.round(Number(n) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Which kind of record an id field points at, and what to call it if deleted.
const REF_FIELDS = {
  handled_by_user_id: { kind: 'user', label: 'Handled by', deleted: 'Deleted account' },
  trade_id: { kind: 'trade', label: 'Trade', deleted: 'Deleted trade' },
  job_type_id: { kind: 'job_type', label: 'Job type', deleted: 'Deleted job type' },
  lead_source_id: { kind: 'list_item', label: 'Lead Source', deleted: 'Deleted Lead Source' },
  original_lead_source_id: { kind: 'list_item', label: "Original job's Lead Source", deleted: 'Deleted Lead Source' },
  not_booked_reason_id: { kind: 'list_item', label: 'Not booked reason', deleted: 'Deleted reason' },
  cancellation_reason_id: { kind: 'list_item', label: 'Cancellation reason', deleted: 'Deleted reason' },
  call_back_reason_id: { kind: 'list_item', label: 'Call back reason', deleted: 'Deleted reason' },
  knockback_reason_id: { kind: 'list_item', label: 'Knock-back reason', deleted: 'Deleted reason' },
  reason_id: { kind: 'list_item', label: 'Reason', deleted: 'Deleted reason' },
  technician_id: { kind: 'technician', label: 'Technician', deleted: 'Deleted technician' },
  install_technician_id: { kind: 'technician', label: 'Install technician', deleted: 'Deleted technician' },
  credited_technician_id: { kind: 'technician', label: 'Credited technician', deleted: 'Deleted technician' },
  attending_technician_id: { kind: 'technician', label: 'Attending technician', deleted: 'Deleted technician' },
  job_id: { kind: 'job', label: 'Linked job', deleted: 'Deleted job' },
  sale_id: { kind: 'sale', label: 'Linked sale', deleted: 'Deleted sale' },
  superseded_by_id: { kind: 'pending_cancellation', label: 'Superseded by', deleted: 'Deleted cancellation' },
};

// Sentence-style entries for archive / conversion links (id held in `to`,
// or `from` when a conversion was removed).
const LINKS = {
  linked_sale_archived: { kind: 'sale', text: (x) => `also archived its linked sale ${x}` },
  linked_sale_restored: { kind: 'sale', text: (x) => `also restored its linked sale ${x}` },
  archived_with_job: { kind: 'job', text: (x) => `archived together with job ${x}` },
  restored_with_job: { kind: 'job', text: (x) => `restored together with job ${x}` },
  archived_with_call: { kind: 'call', text: (x) => `archived together with call ${x}` },
  restored_with_call: { kind: 'call', text: (x) => `restored together with call ${x}` },
  conversion_reversed_for_job: { kind: 'job', text: (x) => `"Converted later" removed from job ${x}` },
  conversion_linked_to_job: { kind: 'job', text: (x) => `linked to its original knock-back job ${x}` },
  conversion_reapplied_for_job: { kind: 'job', text: (x) => `"Converted later" re-applied to job ${x}` },
};
const DELETED_LINK = { sale: 'Deleted sale', job: 'Deleted job', call: 'Deleted call' };

const LABELS = {
  direction: 'Direction',
  call_type: 'Call type',
  booked: 'Booked',
  cancellation_type: 'Cancellation type',
  job_number: 'Job Number',
  new_job_number: 'New Job Number',
  suburb: 'Suburb',
  notes: 'Notes',
  comments: 'Comments',
  visit_date: 'Visit date',
  lead: 'Lead',
  inspection_sheet: 'Inspection sheet',
  option_sheet: 'Option sheet',
  knockback: 'Knock-back',
  work_completion: 'Work completion',
  install_date: 'Install date',
  date_logged: 'Date logged',
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  sale_value_ex_gst: 'Sale value (ex GST)',
  original_sale_value_ex_gst: 'Original sale value (ex GST)',
  aroflo_invoice_value_ex_gst: 'AroFlo invoice value (ex GST)',
  lost_value_ex_gst: 'Lost value (ex GST)',
  lost_value_basis: 'Cancelled',
  aroflo_invoice_status: 'AroFlo invoice status',
  aroflo_captured_at: 'AroFlo details captured',
  follow_up: 'Needs follow-up',
  archived: 'Archived',
  original_lead_source: "Original job's Lead Source",
};
const MONEY = new Set(['sale_value_ex_gst', 'original_sale_value_ex_gst', 'aroflo_invoice_value_ex_gst', 'lost_value_ex_gst']);
const YES_NO = new Set(['knockback', 'follow_up']);
const BASIS = { whole_sale: 'Entire invoice cancelled', part_of_work: 'Part of the work cancelled' };

export function fieldLabel(field) {
  if (LABELS[field]) return LABELS[field];
  if (REF_FIELDS[field]) return REF_FIELDS[field].label;
  const s = String(field).replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plainValue(field, v) {
  if (blank(v)) return DASH;
  if (MONEY.has(field) && Number.isFinite(Number(v))) return money(v);
  if (YES_NO.has(field) && (v === 1 || v === 0 || v === '1' || v === '0')) return Number(v) ? 'Yes' : 'No';
  if (field === 'lost_value_basis') return BASIS[v] || String(v);
  return String(v);
}

// ---- Batched name lookups (one query per kind per page) -------------------

const LOOKUPS = {
  user: { sql: 'SELECT id, name FROM users', name: (r) => r.name },
  trade: { sql: 'SELECT id, name FROM trades', name: (r) => r.name },
  job_type: { sql: 'SELECT id, name FROM job_types', name: (r) => r.name },
  list_item: { sql: 'SELECT id, name FROM list_items', name: (r) => r.name },
  technician: { sql: 'SELECT id, name FROM technicians', name: (r) => r.name },
  job: {
    sql: 'SELECT id, job_number, visit_date FROM jobs',
    name: (r) => `JN ${r.job_number || DASH}${shortDate(r.visit_date) ? ` (visit ${shortDate(r.visit_date)})` : ''}`,
  },
  sale: {
    sql: 'SELECT id, job_number, invoice_number FROM sales',
    name: (r) => `JN ${r.job_number || DASH}${r.invoice_number ? `, invoice ${r.invoice_number}` : ''}`,
  },
  call: {
    sql: 'SELECT id, call_at, job_number FROM calls',
    name: (r) => `${shortDate(r.call_at) || `#${r.id}`}${r.job_number ? ` (JN ${r.job_number})` : ''}`,
  },
  pending_cancellation: {
    sql: 'SELECT id, date_logged, lost_value_ex_gst FROM pending_cancellations',
    name: (r) => `cancellation logged ${shortDate(r.date_logged) || DASH}${blank(r.lost_value_ex_gst) ? '' : ` (${money(r.lost_value_ex_gst)})`}`,
  },
};

const isId = (v) => !blank(v) && /^\d+$/.test(String(v));

function collectIds(entries) {
  const want = {};
  const add = (kind, v) => {
    if (isId(v)) (want[kind] ||= new Set()).add(Number(v));
  };
  for (const changes of entries) {
    for (const [field, ch] of Object.entries(changes || {})) {
      const ref = REF_FIELDS[field] || LINKS[field];
      if (ref) {
        add(ref.kind, ch?.from);
        add(ref.kind, ch?.to);
      } else if (field === 'converted_by_sale') {
        add('sale', ch?.from);
        add('sale', ch?.to);
      }
    }
  }
  return want;
}

function loadNames(want) {
  const names = {};
  for (const [kind, set] of Object.entries(want)) {
    const ids = [...set];
    names[kind] = new Map();
    if (!ids.length) continue;
    const cfg = LOOKUPS[kind];
    const rows = all(`${cfg.sql} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    rows.forEach((r) => names[kind].set(Number(r.id), cfg.name(r)));
  }
  return names;
}

// ---- Describing one entry --------------------------------------------------

function describeOne(changes, names) {
  const ref = (kind, deleted, v) => {
    if (blank(v)) return DASH;
    if (!isId(v)) return String(v);
    return names[kind]?.get(Number(v)) ?? `${deleted} (ID ${v})`;
  };
  const out = [];
  for (const [field, chRaw] of Object.entries(changes || {})) {
    const ch = chRaw || {};
    if (LINKS[field]) {
      const l = LINKS[field];
      out.push(l.text(ref(l.kind, DELETED_LINK[l.kind], ch.to)));
    } else if (field === 'converted_by_sale') {
      out.push(
        !blank(ch.to)
          ? `converted by Quote Approved Later sale ${ref('sale', 'Deleted sale', ch.to)}`
          : `no longer converted by Quote Approved Later sale ${ref('sale', 'Deleted sale', ch.from)}`
      );
    } else if (field === 'stored_knockback_flag') {
      out.push(`stored knock-back flag corrected (${plainValue(field, ch.from)} → ${plainValue(field, ch.to)})`);
    } else if (field === 'aroflo_invoice_id') {
      // AroFlo's internal code means nothing to staff — never shown.
      out.push(`AroFlo invoice reference: ${blank(ch.from) ? 'recorded' : blank(ch.to) ? 'removed' : 'changed'}`);
    } else if (REF_FIELDS[field]) {
      const r = REF_FIELDS[field];
      out.push(`${r.label}: ${ref(r.kind, r.deleted, ch.from)} → ${ref(r.kind, r.deleted, ch.to)}`);
    } else {
      out.push(`${fieldLabel(field)}: ${plainValue(field, ch.from)} → ${plainValue(field, ch.to)}`);
    }
  }
  return out;
}

/** Adds `readable: string[]` to each history/activity entry (which keeps its
 * stored `changes` untouched). Read-only lookups, batched for the page. */
export function withReadableChanges(entries) {
  const names = loadNames(collectIds(entries.map((e) => e.changes)));
  return entries.map((e) => ({ ...e, readable: describeOne(e.changes, names) }));
}
