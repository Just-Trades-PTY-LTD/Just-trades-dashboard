import { all, get, run, transaction } from '../db/index.js';
import { adelaideDateStamp, utcToAdelaideDisplay } from '../lib/adelaideTime.js';
import { marketingAttribution, NO_BOOKED_LEAD_CALL } from './reports.js';

// Stage 4 — Needs Attention. Every item is worked out live from existing
// records each time (read-only): nothing is stored about an item except an
// office user's "Reviewed — leave as is" dismissal (needs_attention_reviews),
// and nothing here ever changes a record. An item disappears when its record
// is fixed, or moves to Closed when dismissed (it stays dismissed until
// someone reopens it, even if the record later changes).
//
// Every item has the same shape so later sources (missed calls, Podium AI and
// webchat enquiries, draft Contacts, AroFlo checks) can be added without
// changing the page:
//   { key, rule, title, jobNumber, date, ageDays, staff, ownerUserIds, open, detail }
// `key` is stable (e.g. "call:72:booked-lead-no-job-number"); `open` says which
// record to open ({ module: 'calls'|'tech'|'followups', kind, id }).

// Rules 3 and 8 only look at jobs from this date (owner decision: September
// history stays in Data Health only).
export const OLDER_RECORDS_CUTOFF = '2026-10-01';

export const RULES = [
  { id: 'booked-lead-no-job-number', title: 'Booked Lead calls with no Job Number', waitDays: 0 },
  { id: 'no-job-number', title: 'Jobs and sales with no Job Number', waitDays: 0 },
  { id: 'unassigned-job', title: 'Jobs with no booked Lead call or Call back call', waitDays: 0, from: OLDER_RECORDS_CUTOFF },
  { id: 'booked-lead-no-entry', title: 'Booked Leads with no job entry after 14 days', waitDays: 14 },
  { id: 'sale-made-mismatch', title: "Sale Made jobs that don't match their sale", waitDays: 0 },
  { id: 'pending-cancellation-details', title: 'Pending Cancellations missing invoice or lost value', waitDays: 2 },
  { id: 'callback-new-job-number', title: 'Call Back entries missing the new callback Job Number', waitDays: 7 },
  { id: 'job-no-suburb', title: 'Jobs with no suburb', waitDays: 0, from: OLDER_RECORDS_CUTOFF },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]));

const norm = (v) => String(v ?? '').trim().toLowerCase();
const day = (v) => String(v || '').slice(0, 10);
function ageDays(date, today) {
  const d = day(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);
}
const userNames = () => new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
const techNames = () => new Map(all('SELECT id, name FROM technicians').map((t) => [t.id, t.name]));
const jobKind = (j) => (j.had_sale_at_visit ? 'new_job_sale_made' : 'new_job_no_sale');
const saleKind = (s) => (s.is_upsell ? 'existing_job_upsell' : s.source === 'quote_approved_later' ? 'quote_approved_later' : 'new_job_sale_made');

/** Every current problem, before dismissals are applied. */
export function computeAllItems(today = adelaideDateStamp()) {
  const users = userNames();
  const techs = techNames();
  const items = [];
  const push = (rule, item) => {
    const age = ageDays(item.date, today);
    if (RULE[rule].waitDays && (age === null || age < RULE[rule].waitDays)) return;
    // "Mine": the user handled the call or created the record.
    items.push({ rule, ageDays: age, ...item, ownerUserIds: (item.ownerUserIds || []).filter(Boolean) });
  };

  // 1. Booked Lead call with no Job Number — straight away, all dates.
  for (const c of all("SELECT id, call_at, handled_by_user_id, created_by_user_id FROM calls WHERE archived = 0 AND call_type = 'Lead' AND booked = 'Yes' AND trim(job_number) = ''")) {
    push('booked-lead-no-job-number', {
      key: `call:${c.id}:booked-lead-no-job-number`,
      title: 'Booked Lead call has no Job Number',
      jobNumber: '',
      date: day(c.call_at),
      staff: users.get(c.handled_by_user_id || c.created_by_user_id) || '',
      ownerUserIds: [c.handled_by_user_id, c.created_by_user_id],
      open: { module: 'calls', id: c.id },
      action: 'Open call to add the Job Number',
    });
  }

  // 2. Job or sale with no Job Number — straight away, all dates.
  for (const j of all("SELECT id, visit_date, had_sale_at_visit, technician_id, created_by_user_id FROM jobs WHERE archived = 0 AND trim(job_number) = ''")) {
    push('no-job-number', {
      key: `job:${j.id}:no-job-number`,
      title: 'Job has no Job Number',
      jobNumber: '',
      date: day(j.visit_date),
      staff: users.get(j.created_by_user_id) || '',
      detail: techs.get(j.technician_id) ? `Technician: ${techs.get(j.technician_id)}` : '',
      ownerUserIds: [j.created_by_user_id],
      open: { module: 'tech', kind: jobKind(j), id: j.id },
      action: 'Open job to add the Job Number',
    });
  }
  for (const s of all("SELECT id, date_logged, source, is_upsell, job_id, invoice_number, created_by_user_id FROM sales WHERE archived = 0 AND trim(job_number) = ''")) {
    // A Sale Made sale opens through its job (the entry staff edit).
    const open = s.source === 'sale_made_at_visit' && s.job_id ? { module: 'tech', kind: 'new_job_sale_made', id: s.job_id } : { module: 'tech', kind: saleKind(s), id: s.id };
    push('no-job-number', {
      key: `sale:${s.id}:no-job-number`,
      title: 'Sale has no Job Number',
      jobNumber: '',
      date: day(s.date_logged),
      staff: users.get(s.created_by_user_id) || '',
      detail: s.invoice_number ? `Invoice ${s.invoice_number}` : '',
      ownerUserIds: [s.created_by_user_id],
      open,
      action: 'Open entry to add the Job Number',
    });
  }

  // 3. Job reporting as Unassigned (no booked Lead call or Call back call) —
  // the reports' own Marketing Category rule, so the two always agree. From
  // 1 Oct 2026.
  {
    const attribution = marketingAttribution();
    const jobs = all(
      `SELECT id, job_number, visit_date, had_sale_at_visit, created_by_user_id FROM jobs
       WHERE archived = 0 AND trim(job_number) <> '' AND visit_date >= ?`,
      [OLDER_RECORDS_CUTOFF]
    );
    for (const j of jobs) {
      if (attribution.categoryOf(j) !== NO_BOOKED_LEAD_CALL) continue;
      push('unassigned-job', {
        key: `job:${j.id}:unassigned-job`,
        title: 'Job has no booked Lead call or Call back call (reports as Unassigned)',
        jobNumber: String(j.job_number).trim(),
        date: day(j.visit_date),
        staff: users.get(j.created_by_user_id) || '',
        ownerUserIds: [j.created_by_user_id],
        open: { module: 'calls', jn: String(j.job_number).trim() },
        action: 'Check Calls & Contacts for this Job Number',
      });
    }
  }

  // 4. Booked Lead with a Job Number but no Technician & Sales entry, sale or
  // cancellation — after 14 days, one item per Job Number (earliest call).
  {
    const entryJns = new Set([
      ...all('SELECT job_number AS jn FROM jobs WHERE archived = 0').map((r) => norm(r.jn)),
      ...all('SELECT job_number AS jn FROM sales WHERE archived = 0 UNION ALL SELECT new_job_number FROM sales WHERE archived = 0').map((r) => norm(r.jn)),
      ...all('SELECT job_number AS jn FROM call_backs WHERE archived = 0 UNION ALL SELECT new_job_number FROM call_backs WHERE archived = 0').map((r) => norm(r.jn)),
      ...all('SELECT job_number AS jn FROM pending_cancellations WHERE archived = 0').map((r) => norm(r.jn)),
      ...all("SELECT job_number AS jn FROM calls WHERE archived = 0 AND call_type = 'Cancellation'").map((r) => norm(r.jn)),
    ]);
    entryJns.delete('');
    const seen = new Set();
    const calls = all(
      `SELECT id, job_number, call_at, handled_by_user_id, created_by_user_id FROM calls
       WHERE archived = 0 AND call_type = 'Lead' AND booked = 'Yes' AND trim(job_number) <> ''
       ORDER BY call_at ASC, id ASC`
    );
    for (const c of calls) {
      const jn = norm(c.job_number);
      if (entryJns.has(jn) || seen.has(jn)) continue;
      seen.add(jn);
      push('booked-lead-no-entry', {
        key: `call:${c.id}:booked-lead-no-entry`,
        title: 'Booked Lead has no Technician & Sales entry, sale or cancellation',
        jobNumber: String(c.job_number).trim(),
        date: day(c.call_at),
        staff: users.get(c.handled_by_user_id || c.created_by_user_id) || '',
        ownerUserIds: [c.handled_by_user_id, c.created_by_user_id],
        open: { module: 'tech', jn: String(c.job_number).trim() },
        action: 'Log the visit in Technician & Sales, or a Cancellation call',
      });
    }
  }

  // 5. Sale Made job and its own sale disagree — the same condition as Data
  // Health's "Sale Made jobs whose sale shows different details".
  for (const r of all(
    `SELECT j.id, j.job_number, j.visit_date, j.created_by_user_id FROM jobs j
     JOIN sales s ON s.job_id = j.id AND s.source = 'sale_made_at_visit' AND s.archived = 0
     WHERE j.archived = 0 AND (
       COALESCE(j.technician_id, 0) <> COALESCE(s.credited_technician_id, 0)
       OR lower(trim(j.job_number)) <> lower(trim(s.job_number))
       OR COALESCE(j.trade_id, 0) <> COALESCE(s.trade_id, 0)
       OR COALESCE(j.job_type_id, 0) <> COALESCE(s.job_type_id, 0)
       OR j.visit_date <> s.date_logged)`
  )) {
    push('sale-made-mismatch', {
      key: `job:${r.id}:sale-made-mismatch`,
      title: "Sale Made job and its sale don't match (technician, Job Number, trade, job type or date)",
      jobNumber: String(r.job_number || '').trim(),
      date: day(r.visit_date),
      staff: users.get(r.created_by_user_id) || '',
      ownerUserIds: [r.created_by_user_id],
      open: { module: 'tech', kind: 'new_job_sale_made', id: r.id },
      action: 'Open job and save it to bring the sale into line',
    });
  }

  // 6. Pending Cancellation without invoice or lost value — after 2 days.
  for (const pc of all(
    `SELECT pc.id, pc.job_number, pc.date_logged, pc.created_by_user_id, c.id AS call_id, c.handled_by_user_id
     FROM pending_cancellations pc
     LEFT JOIN calls c ON c.pending_cancellation_id = pc.id AND c.archived = 0
     WHERE pc.archived = 0 AND pc.superseded_by_id IS NULL
       AND (trim(pc.invoice_number) = '' OR pc.lost_value_ex_gst IS NULL)`
  )) {
    const owner = pc.handled_by_user_id || pc.created_by_user_id || null;
    const ownerIds = [pc.handled_by_user_id, pc.created_by_user_id];
    push('pending-cancellation-details', {
      key: `pending_cancellation:${pc.id}:pending-cancellation-details`,
      title: 'Pending Cancellation has no invoice or lost value recorded',
      jobNumber: String(pc.job_number || '').trim(),
      date: day(pc.date_logged),
      staff: users.get(owner) || '',
      ownerUserIds: ownerIds,
      open: pc.call_id ? { module: 'calls', id: pc.call_id } : { module: 'tech', kind: 'pending_cancellation', id: pc.id },
      action: 'Open the cancellation call to record the invoice and lost value',
    });
  }

  // 7. Call Back entry without the new callback Job Number — after 7 days.
  for (const cb of all("SELECT id, job_number, visit_date, created_by_user_id FROM call_backs WHERE archived = 0 AND trim(new_job_number) = ''")) {
    push('callback-new-job-number', {
      key: `call_back:${cb.id}:callback-new-job-number`,
      title: 'Call Back entry has no new callback Job Number',
      jobNumber: String(cb.job_number || '').trim(),
      date: day(cb.visit_date),
      staff: users.get(cb.created_by_user_id) || '',
      ownerUserIds: [cb.created_by_user_id],
      open: { module: 'tech', kind: 'call_back', id: cb.id },
      action: 'Open the Call Back entry to add the new Job Number',
    });
  }

  // 8. Job with a blank suburb — from 1 Oct 2026.
  for (const j of all(
    "SELECT id, job_number, visit_date, had_sale_at_visit, created_by_user_id FROM jobs WHERE archived = 0 AND trim(suburb) = '' AND visit_date >= ?",
    [OLDER_RECORDS_CUTOFF]
  )) {
    push('job-no-suburb', {
      key: `job:${j.id}:job-no-suburb`,
      title: 'Job has no suburb',
      jobNumber: String(j.job_number || '').trim(),
      date: day(j.visit_date),
      staff: users.get(j.created_by_user_id) || '',
      ownerUserIds: [j.created_by_user_id],
      open: { module: 'tech', kind: jobKind(j), id: j.id },
      action: 'Open job to add the suburb',
    });
  }

  return items;
}

/** Overdue follow-ups (count only — they're managed on the Follow-ups page). */
export function overdueFollowUpCount(today = adelaideDateStamp()) {
  return get("SELECT COUNT(*) AS n FROM follow_ups WHERE status = 'active' AND due_date < ?", [today]).n;
}

function openDismissals() {
  return all('SELECT * FROM needs_attention_reviews WHERE reopened_at IS NULL');
}

/** Active items (not dismissed), optionally only the signed-in user's. */
export function listActive({ userId, mine } = {}) {
  const dismissed = new Set(openDismissals().map((d) => d.item_key));
  const items = computeAllItems().filter((i) => !dismissed.has(i.key) && (!mine || i.ownerUserIds.includes(userId)));
  const groups = RULES.map((r) => ({ ...r, items: items.filter((i) => i.rule === r.id).sort((a, b) => (b.date || '').localeCompare(a.date || '')) }));
  return { total: items.length, groups, overdueFollowUps: overdueFollowUpCount() };
}

/** Dismissed items, newest first — whether the problem still applies is shown. */
export function listClosed() {
  const current = new Map(computeAllItems().map((i) => [i.key, i]));
  return all('SELECT * FROM needs_attention_reviews WHERE reopened_at IS NULL ORDER BY dismissed_at DESC, id DESC').map((d) => {
    const item = current.get(d.item_key);
    return {
      key: d.item_key,
      rule: d.rule,
      ruleTitle: RULE[d.rule]?.title || d.rule,
      label: d.item_label,
      reason: d.reason,
      dismissedBy: d.dismissed_by_name,
      dismissedAt: utcToAdelaideDisplay(d.dismissed_at),
      stillApplies: !!item,
      jobNumber: item?.jobNumber ?? null,
      open: item?.open ?? null,
    };
  });
}

/** Every dismissal and reopening, newest first (for Activity history). */
export function listReviewHistory() {
  const events = [];
  for (const d of all('SELECT * FROM needs_attention_reviews ORDER BY id')) {
    events.push({ at: d.dismissed_at, atLocal: utcToAdelaideDisplay(d.dismissed_at), by: d.dismissed_by_name, action: 'dismissed', label: d.item_label, ruleTitle: RULE[d.rule]?.title || d.rule, reason: d.reason });
    if (d.reopened_at) events.push({ at: d.reopened_at, atLocal: utcToAdelaideDisplay(d.reopened_at), by: d.reopened_by_name, action: 'reopened', label: d.item_label, ruleTitle: RULE[d.rule]?.title || d.rule, reason: d.reason });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

export class NeedsAttentionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const labelOf = (i) => [i.title, i.jobNumber ? `JN ${i.jobNumber}` : '', i.date].filter(Boolean).join(' · ');

/** "Reviewed — leave as is": only a current, not-yet-dismissed item; a reason
 * is required. Records who and when. */
export function dismissItem({ key, reason, user }) {
  const text = String(reason ?? '').trim();
  if (!text) throw new NeedsAttentionError('Please give a reason for leaving this item as it is.');
  if (text.length > 500) throw new NeedsAttentionError('Please keep the reason under 500 characters.');
  return transaction(() => {
    if (get('SELECT id FROM needs_attention_reviews WHERE item_key = ? AND reopened_at IS NULL', [key])) {
      throw new NeedsAttentionError('This item has already been marked reviewed.', 409);
    }
    const item = computeAllItems().find((i) => i.key === key);
    if (!item) throw new NeedsAttentionError('This item no longer needs attention (it may have been fixed). Nothing was changed.', 404);
    run(
      'INSERT INTO needs_attention_reviews (item_key, rule, item_label, reason, dismissed_by_user_id, dismissed_by_name) VALUES (?, ?, ?, ?, ?, ?)',
      [key, item.rule, labelOf(item), text, user.id, user.name]
    );
    return { ok: true };
  });
}

/** Reopen a dismissed item: records who and when; the dismissal stays as history. */
export function reopenItem({ key, user }) {
  const d = get('SELECT id FROM needs_attention_reviews WHERE item_key = ? AND reopened_at IS NULL', [key]);
  if (!d) throw new NeedsAttentionError('This item is not in Closed.', 404);
  run("UPDATE needs_attention_reviews SET reopened_by_user_id = ?, reopened_by_name = ?, reopened_at = datetime('now') WHERE id = ?", [user.id, user.name, d.id]);
  return { ok: true };
}

/** The number shown on the tab and Home: active items (all, not just mine). */
export function activeCount() {
  return listActive({}).total;
}

