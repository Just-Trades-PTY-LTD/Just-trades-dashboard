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

export function findDuplicateInvoice(invoiceNumber, excludeSaleId) {
  const key = normKey(invoiceNumber);
  if (!key) return null;
  return get(
    `SELECT * FROM sales WHERE archived = 0 AND lower(trim(invoice_number)) = ? AND id != ? LIMIT 1`,
    [key, excludeSaleId || 0]
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
