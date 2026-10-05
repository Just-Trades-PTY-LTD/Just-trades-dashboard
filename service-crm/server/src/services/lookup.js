import { get } from '../db/index.js';

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

/** Most recent active sale matching this JN. */
export function findLatestSale(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return null;
  return get(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     LEFT JOIN job_types jt ON jt.id = s.job_type_id
     WHERE s.archived = 0 AND lower(trim(s.job_number)) = ?
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
