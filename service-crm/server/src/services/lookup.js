import { get, all } from '../db/index.js';

export function normKey(v) {
  return (v || '').toString().trim().toLowerCase();
}

/** Most recent active job (any visit, sale-made or not) matching this JN. */
export function findOriginalJob(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT j.*, t.name AS technician_name, tr.name AS trade_name, jt.name AS job_type_name
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN trades tr ON tr.id = j.trade_id
     LEFT JOIN job_types jt ON jt.id = j.job_type_id
     WHERE j.archived = 0 AND lower(trim(j.job_number)) = ?
     ORDER BY j.visit_date DESC, j.id DESC
     LIMIT 1`,
    [key]
  );
}

/** The specific active knock-back (not yet converted) job for this JN, if any — used for the flip. */
export function findConvertibleKnockback(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM jobs
     WHERE archived = 0 AND knockback = 1 AND converted_later = 0 AND lower(trim(job_number)) = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [key]
  );
}

/** Most recent active sale matching this JN. `excludeUpsells` skips Upsell
 * entries (extra work on an existing invoice), e.g. so a pending
 * cancellation links to the job's original sale. */
export function findLatestSale(jobNumber, { excludeUpsells = false } = {}) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     LEFT JOIN job_types jt ON jt.id = s.job_type_id
     WHERE s.archived = 0 AND lower(trim(s.job_number)) = ?${excludeUpsells ? ' AND s.is_upsell = 0' : ''}
     ORDER BY s.invoice_date DESC, s.id DESC
     LIMIT 1`,
    [key]
  );
}

/** The earliest active Calls & Contacts record matching this Job Number
 * (case/whitespace-insensitive), if any — i.e. the linked/original booking
 * record, never a later, unrelated contact that happens to share the JN.
 * Used to auto-populate a new job's Suburb; see db/index.js's
 * 'backfill_job_suburb_from_calls' one-time migration for the same rule
 * applied to jobs that already existed when this shipped. */
/**
 * The report's callback evidence for a Job Number (mirrors reports.js
 * callbackSaleCheck(), so the New Job form says what the report will do):
 * - 'callbackEntry': it's a Technician & Sales Call Back entry's NEW callback
 *   Job Number -> Repeat customer;
 * - 'callbackCall': it's on a Calls & Contacts "Call back" call and isn't any
 *   Call Back entry's ORIGINAL Job Number -> Repeat customer when the job is
 *   visited on or after that call (`callAt` = the earliest such call).
 * null otherwise. Read-only.
 */
export function findCallbackEvidence(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  const callBacks = all('SELECT job_number, new_job_number FROM call_backs WHERE archived = 0');
  if (callBacks.some((cb) => normKey(cb.new_job_number) === key && normKey(cb.new_job_number) !== normKey(cb.job_number))) {
    return { kind: 'callbackEntry' };
  }
  if (callBacks.some((cb) => normKey(cb.job_number) === key)) return null;
  const first = all("SELECT job_number, call_at FROM calls WHERE archived = 0 AND call_type = 'Call back'")
    .filter((c) => normKey(c.job_number) === key && String(c.call_at || '').slice(0, 10))
    .map((c) => String(c.call_at).slice(0, 10))
    .sort()[0];
  return first ? { kind: 'callbackCall', callDate: first } : null;
}

export function findOriginalBookingCall(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM calls
     WHERE archived = 0 AND lower(trim(job_number)) = ?
     ORDER BY call_at ASC, id ASC
     LIMIT 1`,
    [key]
  );
}

/** The Lead call the reports credit this Job Number's Lead Source to — the
 * earliest active Lead call booked "Yes" (ties broken by id), exactly the
 * rule services/reports.js applies in groupBookedLeadsByJobNumber(). Used
 * only to warn on the New Job form when a job has none, so its Lead Source
 * would show as "Unassigned"; never changes what the reports count. */
export function findReportingLeadCall(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT c.*, ls.name AS lead_source_name
     FROM calls c
     LEFT JOIN list_items ls ON ls.id = c.lead_source_id
     WHERE c.archived = 0 AND c.call_type = 'Lead' AND c.booked = 'Yes' AND lower(trim(c.job_number)) = ?
     ORDER BY c.call_at ASC, c.id ASC
     LIMIT 1`,
    [key]
  );
}

export function findDuplicateInvoice(invoiceNumber, excludeSaleId) {
  const key = normKey(invoiceNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM sales WHERE archived = 0 AND lower(trim(invoice_number)) = ? AND id != ? LIMIT 1`,
    [key, excludeSaleId || 0]
  );
}

/** An active Quote Approved Later sale already using this New Job Number, if
 * any (excluding excludeSaleId, for editing). Scoped strictly to
 * source='quote_approved_later' sales — it must never block an unrelated
 * record (a New Job, Call Back, Pending Cancellation, or another sale's own
 * job_number) from legitimately referencing that same AroFlo JN later.
 * Excludes Upsell rows (is_upsell=1) too — they never carry a New Job Number
 * at all, and this check is only about the genuine Quote Approved Later
 * flow. */
export function findDuplicateNewJobNumber(newJobNumber, excludeSaleId) {
  const key = normKey(newJobNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM sales WHERE archived = 0 AND source = 'quote_approved_later' AND is_upsell = 0 AND lower(trim(new_job_number)) = ? AND id != ? LIMIT 1`,
    [key, excludeSaleId || 0]
  );
}

/** The genuine original sale (never another Upsell row) already on record for
 * this exact Job Number + Invoice Number pair — what an "Existing Job —
 * Upsell" entry must link against, since it adds value onto an *existing*
 * invoice rather than creating a new one. Null means no such invoice is on
 * file for that job yet, which blocks creating the Upsell (see
 * routes/techSales.js). */
export function findSaleForInvoice(jobNumber, invoiceNumber) {
  const jnKey = normKey(jobNumber);
  const invKey = normKey(invoiceNumber);
  if (!jnKey || !invKey) return null;
  return get(
    `SELECT * FROM sales
     WHERE archived = 0 AND is_upsell = 0 AND lower(trim(job_number)) = ? AND lower(trim(invoice_number)) = ?
     ORDER BY id DESC LIMIT 1`,
    [jnKey, invKey]
  );
}

/** An active Upsell already recorded for this exact Job Number + Invoice
 * Number + Credited Technician combination (excluding excludeSaleId, for
 * editing) — "the exact same upsell" accidentally entered twice. Deliberately
 * narrow: a different technician upselling onto the same invoice, or the same
 * technician logging a second, separate upsell on a different invoice/date
 * for that job, are both legitimate and never blocked by this. */
export function findDuplicateUpsell(jobNumber, invoiceNumber, creditedTechnicianId, excludeSaleId) {
  const jnKey = normKey(jobNumber);
  const invKey = normKey(invoiceNumber);
  if (!jnKey || !invKey || !creditedTechnicianId) return null;
  return get(
    `SELECT * FROM sales
     WHERE archived = 0 AND is_upsell = 1 AND lower(trim(job_number)) = ? AND lower(trim(invoice_number)) = ?
       AND credited_technician_id = ? AND id != ?
     LIMIT 1`,
    [jnKey, invKey, creditedTechnicianId, excludeSaleId || 0]
  );
}

/** An active Call Back already using this New Callback Job Number, if any
 * (excluding excludeId, for editing). Scoped strictly to call_backs.
 * new_job_number — it must never block an unrelated record (a New Job, Quote
 * Approved Later, Pending Cancellation, or another call back's own
 * job_number/Original Job Number) from legitimately referencing that same
 * AroFlo JN, and it must never flag a call back against its own linked
 * original job as a "duplicate" merely because they're related — those are
 * two entirely different columns. */
export function findDuplicateCallBackJobNumber(newJobNumber, excludeId) {
  const key = normKey(newJobNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM call_backs WHERE archived = 0 AND lower(trim(new_job_number)) = ? AND id != ? LIMIT 1`,
    [key, excludeId || 0]
  );
}

// A deactivated technician/user must never be newly assigned to work — this
// is the backend backstop for that rule, since the picker they'd normally be
// chosen from already excludes them. It only applies to assigning NEW work
// (checked at creation, never on an edit), and never to attribution fields
// like "Credited technician" — a deactivated person can and should still be
// credited for work they already did before leaving.
export function isTechnicianActive(id) {
  if (!id) return true;
  const row = get('SELECT active FROM technicians WHERE id = ?', [id]);
  return !row || !!row.active;
}

export function isUserActive(id) {
  if (!id) return true;
  const row = get('SELECT active FROM users WHERE id = ?', [id]);
  return !row || !!row.active;
}

// The active Quote Follow-up task already on record for this job, if any —
// at most one is ever allowed per job (see routes/followUps.js's own POST),
// so this is both the duplicate check at creation and how "add a follow-up"
// in Job History knows whether to offer "Add" or "View" for a given job.
// The exact job a Quote Approved Later sale flipped from knock-back to
// converted, if any — the reverse of jobs.converted_by_sale_id (see
// routes/techSales.js's own POST /quote-approved-later, which is the only
// place that column is ever set). Used for a single-entry response (the
// create/edit routes); routes/techSales.js's own listTechEntries() computes
// the same thing in bulk via a batched query instead of calling this per row.
// Null means this sale never had a matching active knock-back to convert at
// creation (e.g. it added an extra invoice to an already-sold job) — the
// correct, deliberate "not linked" case, never a job_number text match that
// could coincidentally hit an unrelated job sharing that same JN.
export function findJobConvertedBySale(saleId) {
  if (!saleId) return null;
  return get('SELECT * FROM jobs WHERE converted_by_sale_id = ?', [saleId]);
}

export function findActiveFollowUpForJob(jobId) {
  if (!jobId) return null;
  return get("SELECT * FROM follow_ups WHERE job_id = ? AND status = 'active' LIMIT 1", [jobId]);
}

// Invoice numbers compared loosely: case, spaces and a trailing ".0" (e.g.
// "2181.0" saved from a spreadsheet vs AroFlo's "2181") are ignored.
export function invoiceKey(invoiceNumber) {
  return String(invoiceNumber ?? '').trim().toLowerCase().replace(/\.0+$/, '');
}

/** The CRM sale (not an Upsell) already recording this invoice number, if
 * any — so an AroFlo invoice is never filled into a second sale. */
export function findRecordedSaleForInvoice(invoiceNumber) {
  const key = invoiceKey(invoiceNumber);
  if (!key) return null;
  const rows = all("SELECT id, job_number, source, invoice_number FROM sales WHERE archived = 0 AND is_upsell = 0 AND invoice_number != ''");
  return rows.find((r) => invoiceKey(r.invoice_number) === key) || null;
}
