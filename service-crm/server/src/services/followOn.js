import crypto from 'node:crypto';
import { all, get, run, transaction } from '../db/index.js';
import { normKey } from './lookup.js';

// Follow-on approved quotes — see docs/follow-on-approved-quote-design.md.
//
// A follow-on is a Quote Approved Later sale for new work quoted during an
// earlier approved sale's job and approved separately. It is linked ONLY to
// the approved sale immediately before it (sales.follows_sale_id), never to a
// Technician & Sales job (job_id stays NULL). It keeps its own Original Job
// Number (= the earlier sale's New Job Number) and New Job Number.
// In reports it is a normal sale under Repeat customer, and it is never a
// Converted Later credit and never converts a knockback.

export class FollowOnError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SALE_SELECT = `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name
  FROM sales s
  LEFT JOIN technicians t ON t.id = s.credited_technician_id
  LEFT JOIN trades tr ON tr.id = s.trade_id
  LEFT JOIN job_types jt ON jt.id = s.job_type_id`;

const isApprovedQuote = (s) => !!s && s.source === 'quote_approved_later' && !s.is_upsell;

function saleById(id) {
  if (id === null || id === undefined || id === '') return null;
  return get(`${SALE_SELECT} WHERE s.id = ?`, [Number(id)]) || null;
}

/** Active approved-quote sales (including other follow-ons) whose New Job
 * Number is this Job Number — the possible "earlier approved sale" for a new
 * follow-on. Normally at most one (New Job Numbers are unique among active
 * approved quotes). */
export function findFollowOnSources(jobNumber, { excludeSaleId = null } = {}) {
  const key = normKey(jobNumber);
  if (!key) return [];
  return all(
    `${SALE_SELECT}
     WHERE s.archived = 0 AND s.source = 'quote_approved_later' AND s.is_upsell = 0
       AND lower(trim(s.new_job_number)) = ? AND s.id <> ?
     ORDER BY s.invoice_date DESC, s.id DESC`,
    [key, excludeSaleId === null ? -1 : Number(excludeSaleId)]
  );
}

/** The sales from the start of the chain down to `saleId` (oldest first).
 * Stops safely on a missing record or a loop. */
export function chainSales(saleId) {
  const out = [];
  const seen = new Set();
  let cur = saleById(saleId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.follows_sale_id ? saleById(cur.follows_sale_id) : null;
  }
  return out;
}

/** "JN 2317 → 2373 → 2747": the first sale's Original Job Number, then each
 * sale's New Job Number. `extraNewJn` appends a sale not saved yet. */
export function chainText(sales, extraNewJn) {
  if (!sales.length) return '';
  const parts = [sales[0].job_number || '—', ...sales.map((s) => s.new_job_number || '—')];
  if (extraNewJn !== undefined) parts.push(extraNewJn || '—');
  return `JN ${parts.join(' → ')}`;
}

/** Display details of a chain for one sale: each step, oldest first. */
export function chainDetails(saleId) {
  const sales = chainSales(saleId);
  if (!sales.length) return null;
  const first = sales[0];
  const job = first.job_id ? get('SELECT id, job_number, knockback, converted_later, converted_by_sale_id FROM jobs WHERE id = ?', [first.job_id]) : null;
  return {
    text: chainText(sales),
    startJob: job
      ? { id: job.id, jobNumber: job.job_number, knockback: !!job.knockback, convertedLater: !!job.converted_later }
      : { id: null, jobNumber: first.job_number },
    steps: sales.map((s) => ({
      saleId: s.id,
      jobNumber: s.job_number,
      newJobNumber: s.new_job_number,
      invoiceNumber: s.invoice_number,
      archived: !!s.archived,
      followOn: !!s.follows_sale_id,
    })),
  };
}

/** Sales that follow on directly from `saleId` (active and archived). */
export function followersOf(saleId) {
  return all(
    `SELECT id, job_number, new_job_number, invoice_number, archived FROM sales
     WHERE follows_sale_id = ? AND source = 'quote_approved_later' AND is_upsell = 0 ORDER BY id`,
    [Number(saleId)]
  );
}

/** Every sale further down the chain from `saleId` (its follow-ons, theirs…). */
export function descendantIds(saleId) {
  const out = new Set();
  const queue = [Number(saleId)];
  while (queue.length) {
    const id = queue.shift();
    for (const r of all('SELECT id FROM sales WHERE follows_sale_id = ?', [id])) {
      if (!out.has(r.id) && r.id !== Number(saleId)) {
        out.add(r.id);
        queue.push(r.id);
      }
    }
  }
  return out;
}

/** Short label of an approved sale for messages and history. */
export function saleSummary(s) {
  if (!s) return '';
  const money = `$${(Number(s.sale_value_ex_gst) || 0).toLocaleString('en-AU', { maximumFractionDigits: 2 })}`;
  return `sale #${s.id} (JN ${s.job_number || '—'} → ${s.new_job_number || '—'}${s.invoice_number ? `, invoice ${s.invoice_number}` : ''}, ${money})`;
}

/** Lookup answer for the form: the earlier approved sale(s) this Job Number
 * is the New Job Number of, with the chain so far. */
export function describeSources(jobNumber, { excludeSaleId = null } = {}) {
  return findFollowOnSources(jobNumber, { excludeSaleId }).map((s) => {
    const chain = chainSales(s.id);
    return {
      saleId: s.id,
      jobNumber: s.job_number,
      newJobNumber: s.new_job_number,
      invoiceNumber: s.invoice_number,
      invoiceDate: s.invoice_date,
      saleValueExGst: s.sale_value_ex_gst,
      creditedTechnicianId: s.credited_technician_id,
      creditedTechnician: s.credited_technician_name || '',
      tradeId: s.trade_id,
      trade: s.trade_name || '',
      jobTypeId: s.job_type_id,
      jobType: s.job_type_name || '',
      suburb: s.suburb || '',
      followOn: !!s.follows_sale_id,
      chain: chainText(chain),
    };
  });
}

/** Checks a new follow-on's earlier sale; returns it or throws. */
export function validateNewFollowOn({ followsSaleId, jobNumber, newJobNumber }) {
  const src = saleById(followsSaleId);
  if (!isApprovedQuote(src)) throw new FollowOnError('The earlier approved sale for this follow-on was not found. Nothing was saved.');
  if (src.archived) throw new FollowOnError(`The earlier approved ${saleSummary(src)} is archived. Only an active approved sale can be followed on from. Nothing was saved.`);
  if (!normKey(src.new_job_number) || normKey(src.new_job_number) !== normKey(jobNumber)) {
    throw new FollowOnError(
      `Original Job Number ${jobNumber} is not the New Job Number of the earlier approved ${saleSummary(src)}. Nothing was saved.`
    );
  }
  if (normKey(newJobNumber) === normKey(jobNumber)) {
    throw new FollowOnError('The New Job Number must be different from the Original Job Number. Nothing was saved.');
  }
  return src;
}

// ---- Correct follow-on link (Admin and Staff) -------------------------------

function planCorrection(saleId, jobNumber, reason, { requireReason }) {
  const sale = saleById(saleId);
  if (!isApprovedQuote(sale)) throw new FollowOnError('Quote Approved Later entry not found.', 404);
  if (!sale.follows_sale_id) throw new FollowOnError('This sale is not a follow-on approved quote, so it has no follow-on link to correct.');
  if (!normKey(jobNumber)) throw new FollowOnError('Enter the correct earlier approved Job Number.');
  const current = saleById(sale.follows_sale_id);
  const candidates = all(
    `${SALE_SELECT} WHERE s.source = 'quote_approved_later' AND s.is_upsell = 0 AND lower(trim(s.new_job_number)) = ? ORDER BY s.archived, s.id DESC`,
    [normKey(jobNumber)]
  );
  const active = candidates.filter((c) => !c.archived);
  if (!candidates.length) throw new FollowOnError(`No approved sale has New Job Number ${jobNumber}. Nothing was changed.`);
  if (!active.length) {
    throw new FollowOnError(`The approved sale with New Job Number ${jobNumber} is archived. Only an active approved sale can be linked. Nothing was changed.`);
  }
  if (active.length > 1) {
    throw new FollowOnError(`More than one active approved sale has New Job Number ${jobNumber}. Fix the duplicate first. Nothing was changed.`);
  }
  const replacement = active[0];
  if (replacement.id === sale.id) throw new FollowOnError('A sale cannot follow on from itself. Nothing was changed.');
  if (current && replacement.id === current.id) throw new FollowOnError(`This sale already follows on from ${saleSummary(current)}. Nothing to change.`);
  if (descendantIds(sale.id).has(replacement.id)) {
    throw new FollowOnError(`${saleSummary(replacement)} is a later follow-on of this sale, so linking to it would make the chain circular. Nothing was changed.`);
  }
  if (normKey(replacement.new_job_number) === normKey(sale.new_job_number)) {
    throw new FollowOnError('The Original Job Number would be the same as this sale\'s own New Job Number. Nothing was changed.');
  }
  const why = String(reason || '').trim();
  if (requireReason && !why) throw new FollowOnError('A reason is required.');
  if (why.length > 500) throw new FollowOnError('The reason must be 500 characters or fewer.');

  const beforeChain = chainSales(sale.id);
  const afterChain = [...chainSales(replacement.id), sale];
  const later = [...descendantIds(sale.id)].map((id) => saleById(id)).filter(Boolean);
  const describeLink = (s) => ({
    saleId: s?.id ?? null,
    summary: s ? saleSummary(s) : 'a deleted sale',
    jobNumber: s?.job_number ?? '',
    newJobNumber: s?.new_job_number ?? '',
    invoiceNumber: s?.invoice_number ?? '',
    saleValueExGst: s?.sale_value_ex_gst ?? null,
    creditedTechnician: s?.credited_technician_name ?? '',
    archived: !!s?.archived,
  });
  const preview = {
    saleId: sale.id,
    sale: describeLink(sale),
    current: { link: describeLink(current), originalJobNumber: sale.job_number, chain: chainText(beforeChain) },
    proposed: { link: describeLink(replacement), originalJobNumber: replacement.new_job_number, chain: chainText(afterChain) },
    laterFollowOns: later.map((s) => saleSummary(s)),
    unchanged: 'Sale value, invoice, dates, technician and every other field stay the same. It stays a Repeat customer follow-on sale: no job link, no knockback conversion, no Converted Later credit.',
  };
  preview.token = crypto
    .createHash('sha256')
    .update(JSON.stringify([sale.id, sale.follows_sale_id, sale.job_number, sale.new_job_number, replacement.id, replacement.new_job_number, [...descendantIds(sale.id)]]))
    .digest('hex')
    .slice(0, 32);
  return { sale, current, replacement, preview, reason: why };
}

export function previewCorrection(saleId, jobNumber) {
  return planCorrection(saleId, jobNumber, '', { requireReason: false }).preview;
}

export function applyCorrection(saleId, jobNumber, reason, token, userId) {
  return transaction(() => {
    const plan = planCorrection(saleId, jobNumber, reason, { requireReason: true });
    if (!token || token !== plan.preview.token) {
      throw new FollowOnError('The records involved have changed since you reviewed them. Nothing was changed — please review and confirm again.', 409);
    }
    const { sale, current, replacement, preview } = plan;
    run("UPDATE sales SET follows_sale_id = ?, job_number = ?, updated_at = datetime('now') WHERE id = ?", [
      replacement.id,
      replacement.new_job_number,
      sale.id,
    ]);
    const audit = (entityId, changes) =>
      run('INSERT INTO audit_log (entity_type, entity_id, changes_json, changed_by_user_id) VALUES (?, ?, ?, ?)', [
        'sale',
        entityId,
        JSON.stringify(changes),
        userId || null,
      ]);
    audit(sale.id, {
      follows_sale_id: { from: current?.id ?? sale.follows_sale_id, to: replacement.id },
      job_number: { from: sale.job_number, to: replacement.new_job_number },
      follow_on_link_corrected: {
        from: { link: preview.current.link.summary, originalJobNumber: preview.current.originalJobNumber, chain: preview.current.chain },
        to: { link: preview.proposed.link.summary, originalJobNumber: preview.proposed.originalJobNumber, chain: preview.proposed.chain },
        reason: plan.reason,
      },
    });
    if (current) {
      audit(current.id, { follow_on_unlinked: { from: sale.id, to: null, detail: saleSummary(sale), reason: plan.reason } });
    }
    audit(replacement.id, { follow_on_linked: { from: null, to: sale.id, detail: saleSummary({ ...sale, job_number: replacement.new_job_number }), reason: plan.reason } });
    return { ok: true, saleId: sale.id, chain: preview.proposed.chain };
  });
}
