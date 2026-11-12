// Stage 5 — Calls & Contacts Pending Cancellation: the affected invoice and
// the lost value (always ex GST, always editable). Pure helpers so the rules
// can be tested; nothing here saves anything.

export const BASIS_OPTIONS = [
  { value: 'whole_sale', label: 'Entire invoice cancelled' },
  { value: 'part_of_work', label: 'Part of the work cancelled' },
];
export const basisLabel = (v) => BASIS_OPTIONS.find((o) => o.value === v)?.label || '';

const cents = (n) => Math.round(Number(n) * 100) / 100;
export const money = (n) =>
  n === null || n === undefined || n === '' ? '—' : `$${cents(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const has = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));

/** The details as saved on a call's Pending Cancellation, as form state. */
export function detailsToState(d) {
  return {
    invoiceKey: d?.invoiceNumber ? String(d.invoiceNumber).trim().toLowerCase().replace(/\.0+$/, '') : '',
    invoiceNumber: d?.invoiceNumber || '',
    invoiceDate: d?.invoiceDate || '',
    arofloInvoiceId: d?.arofloInvoiceId || '',
    arofloInvoiceValueExGst: d?.arofloInvoiceValueExGst ?? null,
    arofloInvoiceStatus: d?.arofloInvoiceStatus || '',
    arofloCapturedAt: d?.arofloCapturedAt || '',
    crmValueExGst: d?.originalSaleValueExGst ?? null,
    lostValueExGst: d?.lostValueExGst === null || d?.lostValueExGst === undefined ? '' : String(d.lostValueExGst),
    lostValueBasis: d?.lostValueBasis || '',
    // The saved credited technician, shown as it is (never backfilled).
    creditedTechnicianId: d?.creditedTechnicianId ? String(d.creditedTechnicianId) : '',
  };
}

/** Choosing one invoice from the list (one at a time — never combined). */
export function selectInvoice(state, invoice, capturedAt) {
  if (!invoice) {
    return { ...state, invoiceKey: '', invoiceNumber: '', invoiceDate: '', arofloInvoiceId: '', arofloInvoiceValueExGst: null, arofloInvoiceStatus: '', arofloCapturedAt: '', crmValueExGst: null };
  }
  return {
    ...state,
    invoiceKey: invoice.key,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate || '',
    arofloInvoiceId: invoice.aroflo?.id || '',
    arofloInvoiceValueExGst: invoice.aroflo ? invoice.aroflo.valueExGst : null,
    arofloInvoiceStatus: invoice.aroflo?.status || '',
    arofloCapturedAt: invoice.aroflo ? capturedAt || '' : '',
    crmValueExGst: invoice.crm ? invoice.crm.valueExGst : null,
  };
}

/**
 * What the form says / offers for the lost value:
 * - Entire invoice cancelled: fill only when it's clear — the CRM's recorded
 *   value and AroFlo's current value both known and equal; otherwise both
 *   are shown and staff enter it.
 * - Part of the work cancelled: when AroFlo's current value is LOWER than
 *   the CRM's recorded value, offer the difference with the calculation —
 *   never forced; otherwise staff enter the value of the cancelled work.
 * Returns { fill, offer, text }.
 */
export function lostValueGuidance(state) {
  const crm = has(state.crmValueExGst) ? cents(state.crmValueExGst) : null;
  const aro = has(state.arofloInvoiceValueExGst) ? cents(state.arofloInvoiceValueExGst) : null;
  if (!state.lostValueBasis) return { fill: null, offer: null, text: 'Choose whether the entire invoice or part of the work was cancelled.' };
  if (!state.invoiceNumber) return { fill: null, offer: null, text: 'No invoice selected — enter the lost value ex GST yourself.' };
  if (state.lostValueBasis === 'whole_sale') {
    if (crm !== null && aro !== null && crm === aro) return { fill: crm, offer: null, text: `CRM and AroFlo agree on ${money(crm)} ex GST for this invoice.` };
    if (crm !== null && aro !== null) {
      return { fill: null, offer: null, text: `CRM recorded ${money(crm)} ex GST but AroFlo now shows ${money(aro)} ex GST — enter the lost value yourself.` };
    }
    const known = crm !== null ? `CRM recorded ${money(crm)} ex GST (AroFlo value not available)` : aro !== null ? `AroFlo shows ${money(aro)} ex GST (not recorded on a CRM sale)` : 'No value is known for this invoice';
    return { fill: null, offer: null, text: `${known} — enter the lost value yourself.` };
  }
  if (crm !== null && aro !== null && aro < crm) {
    const diff = cents(crm - aro);
    return { fill: null, offer: diff, text: `CRM recorded ${money(crm)} − AroFlo now ${money(aro)} = ${money(diff)} ex GST.` };
  }
  return { fill: null, offer: null, text: 'Enter the value of the cancelled work ex GST.' };
}

/** The body sent with the call (only when staff changed this section). */
export function detailsPayload(state, confirmed = false) {
  return {
    invoiceNumber: state.invoiceNumber,
    invoiceDate: state.invoiceDate,
    arofloInvoiceId: state.arofloInvoiceId,
    arofloInvoiceValueExGst: state.arofloInvoiceValueExGst,
    arofloInvoiceStatus: state.arofloInvoiceStatus,
    arofloCapturedAt: state.arofloCapturedAt,
    lostValueExGst: state.lostValueExGst === '' ? null : state.lostValueExGst,
    lostValueBasis: state.lostValueBasis,
    confirmed,
  };
}

/**
 * Credited technician on a Pending Cancellation call — from the CRM sale
 * linked to the EXACT selected invoice (never the latest sale); with no
 * invoice selected, only when the Job Number has exactly one CRM sale.
 * Fills only a blank field (or one this rule filled itself, `filled`);
 * a technician staff chose is never replaced — a different one is shown
 * as a difference to choose. Returns { set, source, difference, note }:
 * `set` is the value to put in the field ('' clears this rule's own fill),
 * or null for no change.
 */
export function creditedTechnicianPlan({ pc, invoices, filled }) {
  const list = invoices || [];
  const current = String(pc.creditedTechnicianId || '');
  const mine = !!filled && current === String(filled);
  let source = null;
  let note = null;
  if (pc.invoiceKey) {
    const inv = list.find((i) => i.key === pc.invoiceKey);
    if (inv?.crm?.creditedTechnicianId) source = { id: String(inv.crm.creditedTechnicianId), name: inv.crm.creditedTechnicianName, invoiceNumber: inv.invoiceNumber };
    else if (inv) note = `Invoice ${inv.invoiceNumber} isn't on a CRM sale with a credited technician, so none is suggested — choose the technician.`;
  } else if (list.length) {
    const sales = [...new Map(list.filter((i) => i.crm).map((i) => [i.crm.saleId, i])).values()];
    if (sales.length === 1 && sales[0].crm.creditedTechnicianId) {
      const i = sales[0];
      source = { id: String(i.crm.creditedTechnicianId), name: i.crm.creditedTechnicianName, invoiceNumber: i.invoiceNumber };
    } else if (sales.length > 1) note = `This Job Number has ${sales.length} CRM sales — select the invoice, or choose the technician.`;
  }
  if (source) {
    if (!current || mine) return { set: current === source.id ? null : source.id, source, difference: null, note: null };
    if (current !== source.id) return { set: null, source: null, difference: source, note: null };
    return { set: null, source: null, difference: null, note: null };
  }
  return { set: mine ? '' : null, source: null, difference: null, note };
}
