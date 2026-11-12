// Stage 6 — Existing Job — Upsell: which invoice it's on, and what AroFlo
// can suggest for it. Pure helpers (tested); nothing here saves anything.
// Either way the Upsell reports under the original job — its own invoice and
// reference Job Number never change its Marketing Category.

export const INVOICE_MODES = [
  { value: 'existing', label: 'The existing invoice on the original job' },
  { value: 'separate', label: 'A separate invoice / AroFlo Job Number' },
];

const cents = (n) => Math.round(Number(n) * 100) / 100;
const has = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
export const money = (n) => `$${cents(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const key = (inv) => String(inv ?? '').trim().toLowerCase().replace(/\.0+$/, '');

/**
 * (A) Existing invoice: the Upsell value is entered by staff. When AroFlo's
 * CURRENT total for that invoice is higher than what the CRM has recorded on
 * it (original sale + earlier Upsells), the difference is offered as "Use
 * this", with the calculation — never filled, never overwriting.
 * `arofloInvoices`: the original Job Number's AroFlo lookup invoices;
 * `crm`: /lookup/upsell-invoice. Returns { offer, text } (offer may be null).
 */
export function existingInvoiceSuggestion({ arofloInvoices, invoiceNumber, crm }) {
  if (!key(invoiceNumber)) return null;
  const inv = (arofloInvoices || []).find((i) => key(i.invoiceNumber) === key(invoiceNumber));
  if (!crm?.found) return inv ? { offer: null, text: `Invoice ${invoiceNumber} isn't on a CRM sale for this Job Number, so no amount is suggested.` } : null;
  if (!inv || !has(inv.saleValueExGst)) {
    return { offer: null, text: `CRM has ${money(crm.recordedExGst)} ex GST recorded on invoice ${invoiceNumber}. Look up the original Job Number in AroFlo to compare with its current total.` };
  }
  const aro = cents(inv.saleValueExGst);
  const recorded = cents(crm.recordedExGst);
  const parts = crm.upsellCount ? `sale ${money(crm.saleValueExGst)} + earlier Upsells ${money(crm.upsellValueExGst)}` : `sale ${money(crm.saleValueExGst)}`;
  if (aro > recorded) {
    const diff = cents(aro - recorded);
    return { offer: diff, text: `AroFlo invoice ${invoiceNumber} is now ${money(aro)} − CRM recorded ${money(recorded)} (${parts}) = ${money(diff)} ex GST.` };
  }
  return { offer: null, text: `AroFlo invoice ${invoiceNumber} is ${money(aro)} ex GST — not higher than the CRM's recorded ${money(recorded)} (${parts}), so no amount is suggested. Enter the Upsell value yourself.` };
}

const FILLABLE_TYPES = ['FINAL_INVOICE', 'SALES_INVOICE'];
const typeLabel = (t) => String(t || '').replace(/_INVOICE$/, '').replace(/_/g, ' ').toLowerCase() || 'unknown';
const recordedNote = (inv) => `invoice ${inv.invoiceNumber} is already recorded on JN ${inv.alreadyRecorded.jobNumber} (${inv.alreadyRecorded.kind})`;

/**
 * (B) Separate invoice: the separate AroFlo Job Number's invoices.
 * Fills invoice number, date and value together (blank fields only) ONLY
 * when that job has exactly one invoice, it's a final or sales invoice, and
 * it isn't already recorded in the CRM. Otherwise each usable invoice is
 * offered as "Use this", and a recorded one is shown but can't be used.
 * Returns { wanted, notes, choices }.
 */
export function planSeparateInvoiceFill({ result, jobNumber }) {
  const out = { wanted: {}, notes: [], choices: [] };
  if (!result?.found) {
    out.notes.push(result?.message || `No AroFlo job found for ${jobNumber} — enter the invoice details yourself.`);
    return out;
  }
  const invoices = result.invoices || [];
  if (!invoices.length) {
    out.notes.push(`AroFlo has no invoice on JN ${jobNumber} yet — enter the invoice details yourself.`);
    return out;
  }
  const usable = invoices.filter((i) => !i.alreadyRecorded);
  invoices.filter((i) => i.alreadyRecorded).forEach((i) => out.notes.push(`AroFlo's ${recordedNote(i)}, so it can't be used for this Upsell.`));
  const asChoice = (i) => ({ invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate || '', saleValueExGst: i.saleValueExGst, status: i.status || '', type: i.type || '' });
  if (invoices.length === 1 && usable.length === 1) {
    const i = usable[0];
    if (FILLABLE_TYPES.includes(String(i.type || '').toUpperCase())) {
      out.wanted = { invoiceNumber: i.invoiceNumber, ...(i.invoiceDate ? { invoiceDate: i.invoiceDate } : {}), saleValueExGst: i.saleValueExGst };
      return out;
    }
    out.notes.push(`AroFlo's only invoice on JN ${jobNumber} is a ${typeLabel(i.type)} invoice, so it isn't filled in automatically — use it below if it's right.`);
    out.choices.push(asChoice(i));
    return out;
  }
  if (usable.length) {
    if (invoices.length > 1) out.notes.push(`AroFlo has ${invoices.length} invoices on JN ${jobNumber} — choose the one for this Upsell.`);
    out.choices = usable.map(asChoice);
  }
  return out;
}
