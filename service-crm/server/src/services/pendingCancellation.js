import { all, get, run } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { invoiceKey, normKey } from './lookup.js';

// Stage 5 — a Pending Cancellation's affected invoice and lost value,
// recorded only through its Calls & Contacts call (Cancellation -> Pending
// Cancellation). Nothing here changes a sale, its revenue or any report
// figure: these fields are information on the cancellation only.

export const PC_DETAIL_FIELDS = [
  'aroflo_invoice_id',
  'invoice_number',
  'invoice_date',
  'original_sale_value_ex_gst',
  'aroflo_invoice_value_ex_gst',
  'aroflo_invoice_status',
  'aroflo_captured_at',
  'lost_value_ex_gst',
  'lost_value_basis',
];
const BASES = ['', 'whole_sale', 'part_of_work'];
export const BASIS_LABELS = { whole_sale: 'Entire invoice cancelled', part_of_work: 'Part of the work cancelled' };

const cents = (n) => Math.round(Number(n) * 100) / 100;
export const money = (n) => `$${cents(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The CRM's invoices for a Job Number: each original sale (never an Upsell)
 * with an invoice number, its value ex GST including any Upsells recorded on
 * the same invoice for that Job Number. One entry per invoice — never
 * combined across invoices.
 */
export function crmInvoicesForJob(jobNumber) {
  const key = normKey(jobNumber);
  if (!key) return [];
  const sales = all("SELECT * FROM sales WHERE archived = 0 AND invoice_number != '' ORDER BY id").filter((s) => normKey(s.job_number) === key);
  const byInvoice = new Map();
  for (const s of sales.filter((x) => !x.is_upsell)) {
    const k = invoiceKey(s.invoice_number);
    if (!byInvoice.has(k)) byInvoice.set(k, { key: k, saleId: s.id, invoiceNumber: s.invoice_number.trim(), invoiceDate: s.invoice_date || '', saleValueExGst: cents(s.sale_value_ex_gst || 0), upsellValueExGst: 0, upsellCount: 0 });
  }
  for (const u of sales.filter((x) => x.is_upsell)) {
    const inv = byInvoice.get(invoiceKey(u.invoice_number));
    if (inv) {
      inv.upsellValueExGst = cents(inv.upsellValueExGst + Number(u.sale_value_ex_gst || 0));
      inv.upsellCount += 1;
    }
  }
  return [...byInvoice.values()].map((i) => ({ ...i, crmValueExGst: cents(i.saleValueExGst + i.upsellValueExGst) }));
}

/** Other active Pending Cancellations already recorded on this invoice. */
export function cancellationsOnInvoice(invoiceNumber, excludeId = null) {
  const k = invoiceKey(invoiceNumber);
  if (!k) return [];
  return all("SELECT * FROM pending_cancellations WHERE archived = 0 AND invoice_number != '' ORDER BY date_logged, id")
    .filter((pc) => invoiceKey(pc.invoice_number) === k && pc.id !== Number(excludeId || 0))
    .map((pc) => ({
      id: pc.id,
      jobNumber: pc.job_number,
      dateLogged: pc.date_logged,
      lostValueExGst: pc.lost_value_ex_gst,
      basis: pc.lost_value_basis,
      supersededById: pc.superseded_by_id || null,
    }));
}

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? cents(n) : NaN;
};

/**
 * Checks the details a Pending Cancellation call sends. Returns { values,
 * saleId, error }. The CRM value and the sale link come from the CRM itself
 * (the sale matching the selected invoice on this Job Number) — never from
 * the request and never the "latest sale" guess. AroFlo's value, status and
 * capture time are the snapshot staff saw when choosing the invoice.
 */
export function checkDetails(details, jobNumber) {
  const d = details || {};
  const lost = numOrNull(d.lostValueExGst);
  if (Number.isNaN(lost) || (lost !== null && lost < 0)) return { error: 'Lost value must be an amount ex GST of $0 or more.' };
  const arofloValue = numOrNull(d.arofloInvoiceValueExGst);
  if (Number.isNaN(arofloValue)) return { error: "The AroFlo invoice value couldn't be read — look up the invoices again." };
  const basis = String(d.lostValueBasis || '');
  if (!BASES.includes(basis)) return { error: 'Choose "Entire invoice cancelled" or "Part of the work cancelled".' };
  const invoiceNumber = String(d.invoiceNumber || '').trim();
  const invoiceDate = String(d.invoiceDate || '').trim();
  if (invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return { error: 'The invoice date must be a date.' };
  const crm = invoiceNumber ? crmInvoicesForJob(jobNumber).find((i) => i.key === invoiceKey(invoiceNumber)) : null;
  return {
    values: {
      aroflo_invoice_id: invoiceNumber ? String(d.arofloInvoiceId || '').trim() : '',
      invoice_number: invoiceNumber,
      invoice_date: invoiceNumber ? invoiceDate || crm?.invoiceDate || '' : '',
      original_sale_value_ex_gst: crm ? crm.crmValueExGst : null,
      aroflo_invoice_value_ex_gst: invoiceNumber ? arofloValue : null,
      aroflo_invoice_status: invoiceNumber ? String(d.arofloInvoiceStatus || '').trim() : '',
      aroflo_captured_at: invoiceNumber && arofloValue !== null ? String(d.arofloCapturedAt || '').trim() : '',
      lost_value_ex_gst: lost,
      lost_value_basis: basis,
    },
    saleId: crm ? crm.saleId : null,
  };
}

/**
 * Whether saving needs staff to confirm first, against the other
 * cancellations on the same invoice:
 * - 'supersede': this is an Entire invoice cancellation and earlier "Part of
 *   the work" cancellations (logged on or before it, not already superseded)
 *   exist — they'll be superseded for reporting and kept in history;
 * - 'confirmLostValue': any other existing cancellation on this invoice.
 * Only asked when the invoice, basis or lost value is new or changed.
 */
export function confirmationNeeded(values, pcId, dateLogged, before) {
  if (!values.invoice_number) return null;
  const unchanged =
    before &&
    invoiceKey(before.invoice_number) === invoiceKey(values.invoice_number) &&
    before.lost_value_basis === values.lost_value_basis &&
    String(before.lost_value_ex_gst ?? '') === String(values.lost_value_ex_gst ?? '');
  if (unchanged) return null;
  const others = cancellationsOnInvoice(values.invoice_number, pcId).filter((o) => !o.supersededById || o.supersededById === pcId);
  if (!others.length) return null;
  const describe = (o) => `${o.lostValueExGst === null ? 'an unrecorded amount' : `${money(o.lostValueExGst)} ex GST`}`;
  const toSupersede = values.lost_value_basis === 'whole_sale' ? others.filter((o) => o.basis === 'part_of_work' && (!dateLogged || o.dateLogged <= dateLogged)) : [];
  if (toSupersede.length && toSupersede.length === others.length) {
    const amounts = toSupersede.map(describe).join(' and ');
    return {
      kind: 'supersede',
      ids: toSupersede.map((o) => o.id),
      message: `This invoice already has ${toSupersede.length === 1 ? 'a cancellation entry' : `${toSupersede.length} cancellation entries`} for ${amounts}. Saving this entire-invoice cancellation will supersede ${toSupersede.length === 1 ? 'that entry' : 'those entries'} for reporting. The earlier record${toSupersede.length === 1 ? '' : 's'} will remain in history.`,
    };
  }
  const list = others.map((o) => `${describe(o)} (${BASIS_LABELS[o.basis] || 'basis not recorded'}, ${o.dateLogged})`).join('; ');
  const lost = values.lost_value_ex_gst === null ? 'no lost value' : `a lost value of ${money(values.lost_value_ex_gst)} ex GST`;
  return {
    kind: 'confirmLostValue',
    ids: [],
    message: `This invoice already has ${others.length === 1 ? 'a cancellation entry' : `${others.length} cancellation entries`}: ${list}. Nothing will be superseded. Please confirm ${lost} for this entry is correct and isn't the same loss recorded twice.`,
  };
}

const TRACKED = [...PC_DETAIL_FIELDS, 'sale_id'];

/**
 * Saves the details onto the Pending Cancellation (inside the call's
 * transaction), re-links it to the CRM sale for the selected invoice when
 * there is one, supersedes earlier partial cancellations staff confirmed,
 * and releases any it superseded that no longer qualify. Every change is in
 * Activity history; superseding only sets the earlier record's link.
 */
export function applyDetails(pcId, { values, saleId }, { supersedeIds = [] } = {}, userId) {
  const before = get('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]);
  if (!before) return;
  const next = { ...before, ...values, sale_id: saleId || before.sale_id };
  run(
    `UPDATE pending_cancellations SET aroflo_invoice_id=?, invoice_number=?, invoice_date=?, original_sale_value_ex_gst=?,
      aroflo_invoice_value_ex_gst=?, aroflo_invoice_status=?, aroflo_captured_at=?, lost_value_ex_gst=?, lost_value_basis=?,
      sale_id=?, updated_at=datetime('now') WHERE id=?`,
    [...PC_DETAIL_FIELDS.map((f) => next[f]), next.sale_id, pcId]
  );
  recordAudit({ entityType: 'pending_cancellation', entityId: pcId, before, after: next, fields: TRACKED, userId });

  // Release records this one superseded that no longer qualify.
  const stillWhole = next.lost_value_basis === 'whole_sale' && next.invoice_number;
  for (const r of all('SELECT * FROM pending_cancellations WHERE superseded_by_id = ?', [pcId])) {
    if (stillWhole && invoiceKey(r.invoice_number) === invoiceKey(next.invoice_number)) continue;
    run('UPDATE pending_cancellations SET superseded_by_id = NULL WHERE id = ?', [r.id]);
    recordAudit({ entityType: 'pending_cancellation', entityId: r.id, before: r, after: { ...r, superseded_by_id: null }, fields: ['superseded_by_id'], userId });
  }
  if (!stillWhole) return;
  for (const id of supersedeIds) {
    const r = get('SELECT * FROM pending_cancellations WHERE id = ?', [id]);
    if (!r || r.id === pcId || r.archived || r.lost_value_basis !== 'part_of_work' || invoiceKey(r.invoice_number) !== invoiceKey(next.invoice_number)) continue;
    if (r.superseded_by_id === pcId) continue;
    run('UPDATE pending_cancellations SET superseded_by_id = ? WHERE id = ?', [pcId, r.id]);
    recordAudit({ entityType: 'pending_cancellation', entityId: r.id, before: r, after: { ...r, superseded_by_id: pcId }, fields: ['superseded_by_id'], userId });
  }
}

/** Read-only summary of a Pending Cancellation's details for the forms. */
export function detailsOf(pc) {
  if (!pc) return null;
  const supersedes = all('SELECT id, lost_value_ex_gst, date_logged FROM pending_cancellations WHERE superseded_by_id = ? ORDER BY id', [pc.id]);
  return {
    id: pc.id,
    recorded: !!(pc.invoice_number || pc.lost_value_ex_gst !== null || pc.lost_value_basis),
    arofloInvoiceId: pc.aroflo_invoice_id || '',
    invoiceNumber: pc.invoice_number || '',
    invoiceDate: pc.invoice_date || '',
    originalSaleValueExGst: pc.original_sale_value_ex_gst,
    arofloInvoiceValueExGst: pc.aroflo_invoice_value_ex_gst,
    arofloInvoiceStatus: pc.aroflo_invoice_status || '',
    arofloCapturedAt: pc.aroflo_captured_at || '',
    lostValueExGst: pc.lost_value_ex_gst,
    lostValueBasis: pc.lost_value_basis || '',
    supersededById: pc.superseded_by_id || null,
    supersedes: supersedes.map((s) => ({ id: s.id, lostValueExGst: s.lost_value_ex_gst, dateLogged: s.date_logged })),
  };
}
