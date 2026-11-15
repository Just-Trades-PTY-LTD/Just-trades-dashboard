import { all, get } from '../db/index.js';

// Settings lists (Lead Sources, reasons), Trades and Job types: the rules for
// hiding, naming, removing and requiring comments. Records always store an
// item's id — never its name — so renaming an item renames it everywhere and
// reports keep grouping it as the same category. Nothing here rewrites a
// record.

export const LIST_CATEGORIES = [
  'lead_source',
  'not_booked_reason',
  'new_job_cancellation_reason',
  'knockback_reason',
  'callback_reason',
  'pending_cancellation_reason',
];
/** Lists whose items are reasons (they can require comments). */
export const REASON_CATEGORIES = LIST_CATEGORIES.filter((c) => c !== 'lead_source');

// Labels reports use for "nothing recorded" buckets — an item with one of
// these names would merge with the blanks, so they can't be used.
export const RESERVED_NAMES = ['Unassigned', 'Not specified', 'Unassigned (no booked Lead call)'];

const key = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** A problem with a proposed name, or null. `scope`: { table, category?,
 * tradeId?, excludeId? } — names are unique within one list (hidden items
 * included), within one Trade's Job types, and across Trades. */
export function nameProblem(name, scope) {
  const n = String(name ?? '').trim();
  if (!n) return 'Name is required.';
  if (n.length > 120) return 'Please keep the name under 120 characters.';
  if (RESERVED_NAMES.some((r) => key(r) === key(n))) return `"${n}" is used by the reports for blank values — please choose another name.`;
  let rows = [];
  if (scope.table === 'list_items') rows = all('SELECT id, name FROM list_items WHERE category = ?', [scope.category]);
  else if (scope.table === 'job_types') rows = all('SELECT id, name FROM job_types WHERE trade_id = ?', [scope.tradeId]);
  else if (scope.table === 'trades') rows = all('SELECT id, name FROM trades');
  const clash = rows.find((r) => r.id !== Number(scope.excludeId || 0) && key(r.name) === key(n));
  if (clash) return `There is already an item called "${clash.name}" in this list (it may be hidden) — names must be different.`;
  return null;
}

/** A free "New item", "New item 2", … name for the Add button. */
export function freeName(base, scope) {
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? base : `${base} ${i}`;
    if (!nameProblem(n, scope)) return n;
  }
  return `${base} ${Date.now()}`;
}

// Every table/column that refers to list_items, trades or job_types, read
// from the database itself so a table added later is counted automatically.
function referencesTo(table) {
  const refs = [];
  for (const t of all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
    for (const fk of all(`PRAGMA foreign_key_list('${t.name}')`)) {
      if (fk.table === table) refs.push({ table: t.name, column: fk.from });
    }
  }
  return refs;
}

const LABELS = {
  calls: ['call', 'calls'],
  jobs: ['job', 'jobs'],
  sales: ['sale', 'sales'],
  call_backs: ['Call Back entry', 'Call Back entries'],
  pending_cancellations: ['Pending Cancellation', 'Pending Cancellations'],
  job_types: ['job type', 'job types'],
};

/** How many records use an item: { total, text }. Job types belonging to a
 * Trade aren't "records" — a Trade's own job types are counted separately. */
export function usageOf(table, id) {
  let total = 0;
  const parts = [];
  for (const r of referencesTo(table)) {
    if (table === 'trades' && r.table === 'job_types') continue;
    const n = get(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.column} = ?`, [id]).n;
    if (!n) continue;
    total += n;
    const [one, many] = LABELS[r.table] || [r.table, r.table];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return { total, text: parts.join(', ') };
}

/** Usage counts for every item in one go (for the Settings screen). */
export function usageMap(table) {
  const map = new Map();
  for (const r of referencesTo(table)) {
    if (table === 'trades' && r.table === 'job_types') continue;
    for (const row of all(`SELECT ${r.column} AS id, COUNT(*) AS n FROM ${r.table} WHERE ${r.column} IS NOT NULL GROUP BY ${r.column}`)) {
      map.set(row.id, (map.get(row.id) || 0) + row.n);
    }
  }
  return map;
}

// ---- "Repeat customer" Lead Source, by id ----------------------------------
// Callbacks and callback sales are credited to this Lead Source. It's found
// by its id (saved in app_settings) so it can be renamed freely. Until one is
// saved (e.g. a brand-new install), the single Lead Source named "Repeat
// customer" is used — the CRM's original behaviour.
export const REPEAT_CUSTOMER_SETTING = 'repeat_customer_lead_source_id';

export function repeatCustomerLeadSource() {
  const row = get('SELECT value FROM app_settings WHERE key = ?', [REPEAT_CUSTOMER_SETTING]);
  const id = Number(row?.value);
  if (Number.isInteger(id) && id > 0) {
    const item = get("SELECT id, name, hidden_at FROM list_items WHERE id = ? AND category = 'lead_source'", [id]);
    if (item) return { id: item.id, name: item.name, source: 'setting' };
  }
  const named = all("SELECT id, name FROM list_items WHERE category = 'lead_source' AND lower(trim(name)) = 'repeat customer'");
  if (named.length === 1) return { id: named[0].id, name: named[0].name, source: 'name' };
  return { id: null, name: 'Repeat customer', source: 'none' };
}

// ---- Hidden items on records ----------------------------------------------
// Request-body field -> which kind of item it holds.
export const ITEM_FIELDS = {
  tradeId: 'trade',
  jobTypeId: 'job_type',
  leadSourceId: 'list_item',
  originalLeadSourceId: 'list_item',
  notBookedReasonId: 'list_item',
  cancellationReasonId: 'list_item',
  callBackReasonId: 'list_item',
  knockbackReasonId: 'list_item',
  reasonId: 'list_item',
};
const REASON_FIELDS = ['notBookedReasonId', 'cancellationReasonId', 'callBackReasonId', 'knockbackReasonId', 'reasonId'];
const snake = (f) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const blank = (v) => v === null || v === undefined || v === '';

/** Why an item can't be newly chosen (hidden, or its Trade is hidden), or null. */
function unavailable(kind, id) {
  if (kind === 'trade') {
    const t = get('SELECT name, hidden_at FROM trades WHERE id = ?', [id]);
    return t?.hidden_at ? `The Trade "${t.name}" is hidden in Settings and can't be chosen for new entries.` : null;
  }
  if (kind === 'job_type') {
    const j = get('SELECT jt.name, jt.hidden_at, t.name AS trade, t.hidden_at AS trade_hidden FROM job_types jt JOIN trades t ON t.id = jt.trade_id WHERE jt.id = ?', [id]);
    if (j?.trade_hidden) return `The Trade "${j.trade}" is hidden in Settings, so its Job types can't be chosen for new entries.`;
    return j?.hidden_at ? `The Job type "${j.name}" is hidden in Settings and can't be chosen for new entries.` : null;
  }
  const i = get('SELECT name, hidden_at FROM list_items WHERE id = ?', [id]);
  return i?.hidden_at ? `"${i.name}" is hidden in Settings and can't be chosen for new entries.` : null;
}

/** Express middleware for a record's create/edit route: refuses a hidden item
 * (or a Job type of a hidden Trade) when it is being newly set, and a blank
 * comment when a newly set reason requires comments. Keeping a record's
 * existing value is always allowed. `table`: the stored row compared on edit
 * (`:id`); `commentField`: the body field holding the record's comments. */
export function recordItemGuard({ table, commentField }) {
  return (req, res, next) => {
    const b = req.body || {};
    const stored = table && req.params.id ? get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]) : null;
    const isNew = (field) => {
      const v = b[field];
      if (blank(v)) return false;
      if (!stored) return true;
      const col = snake(field);
      return !(col in stored) || String(stored[col] ?? '') !== String(v);
    };
    for (const [field, kind] of Object.entries(ITEM_FIELDS)) {
      if (!isNew(field)) continue;
      const problem = unavailable(kind, b[field]);
      if (problem) return res.status(400).json({ error: `${problem} Nothing was saved.` });
    }
    if (commentField) {
      const storedComment = stored ? stored[snake(commentField)] ?? '' : '';
      const comment = String(b[commentField] ?? storedComment ?? '').trim();
      const blanking = stored && commentField in b && !String(b[commentField] ?? '').trim();
      for (const field of REASON_FIELDS) {
        const value = b[field] !== undefined ? b[field] : stored?.[snake(field)];
        if (blank(value) || (!isNew(field) && !blanking)) continue;
        const reason = get('SELECT name, requires_comment FROM list_items WHERE id = ?', [value]);
        if (reason?.requires_comment && !comment) {
          return res.status(400).json({ error: `Please add a comment — the reason "${reason.name}" requires one. Nothing was saved.` });
        }
      }
    }
    next();
  };
}
