import { all } from '../db/index.js';
import { findRecordedSaleForInvoice, invoiceKey, normKey } from './lookup.js';

// Stage 6 — an Existing Job — Upsell is recorded either on the original job's
// EXISTING invoice ('existing') or on a SEPARATE invoice / AroFlo Job Number
// ('separate'). Either way it reports under the original job (reports.js
// resolveUpsell); its own invoice and reference Job Number (new_job_number)
// only identify and value it.

/** 'separate' when it has a separate reference Job Number, or its invoice
 * isn't the invoice of an original (non-Upsell) CRM sale on its Job Number. */
export function upsellInvoiceMode(sale) {
  if (!sale?.is_upsell) return null;
  if (String(sale.new_job_number || '').trim()) return 'separate';
  const k = invoiceKey(sale.invoice_number);
  const onOriginal = all('SELECT invoice_number, job_number FROM sales WHERE archived = 0 AND is_upsell = 0').some(
    (s) => normKey(s.job_number) === normKey(sale.job_number) && invoiceKey(s.invoice_number) === k
  );
  if (onOriginal) return 'existing';
  return sale.job_id ? 'separate' : 'existing';
}

/** A separate Upsell invoice must not already be a CRM sale's invoice. */
export function separateInvoiceProblem(invoiceNumber) {
  const recorded = findRecordedSaleForInvoice(invoiceNumber);
  if (!recorded) return null;
  const kind = recorded.source === 'quote_approved_later' ? 'Quote Approved Later' : 'Sale Made';
  return `Invoice ${String(invoiceNumber).trim()} is already recorded on JN ${String(recorded.job_number).trim()} (${kind}), so it can't be used as a separate Upsell invoice. If the Upsell was added to that invoice, choose "The existing invoice on the original job".`;
}

/** What the CRM has recorded on an existing invoice of this Job Number: the
 * original sale plus every Upsell on it (except `excludeSaleId`, the Upsell
 * being edited). All ex GST. */
export function crmRecordedOnInvoice(jobNumber, invoiceNumber, excludeSaleId = null) {
  const k = invoiceKey(invoiceNumber);
  if (!normKey(jobNumber) || !k) return null;
  const rows = all('SELECT id, is_upsell, sale_value_ex_gst, invoice_number, job_number FROM sales WHERE archived = 0').filter(
    (s) => normKey(s.job_number) === normKey(jobNumber) && invoiceKey(s.invoice_number) === k && s.id !== Number(excludeSaleId || 0)
  );
  const sale = rows.find((r) => !r.is_upsell);
  if (!sale) return null;
  const upsells = rows.filter((r) => r.is_upsell);
  const cents = (n) => Math.round(Number(n) * 100) / 100;
  const upsellValue = cents(upsells.reduce((t, u) => t + Number(u.sale_value_ex_gst || 0), 0));
  return {
    saleValueExGst: cents(sale.sale_value_ex_gst || 0),
    upsellValueExGst: upsellValue,
    upsellCount: upsells.length,
    recordedExGst: cents(Number(sale.sale_value_ex_gst || 0) + upsellValue),
  };
}

/** An invoice recorded as a SEPARATE-invoice Upsell (not on any sale). */
export function findSeparateUpsellForInvoice(invoiceNumber) {
  const k = invoiceKey(invoiceNumber);
  if (!k) return null;
  return all("SELECT * FROM sales WHERE archived = 0 AND is_upsell = 1 AND invoice_number != ''").find(
    (u) => invoiceKey(u.invoice_number) === k && upsellInvoiceMode(u) === 'separate'
  ) || null;
}
