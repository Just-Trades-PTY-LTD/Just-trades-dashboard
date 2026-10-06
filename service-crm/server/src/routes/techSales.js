import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, getHistory, getHistoryCounts, getLastEditedInfo } from '../lib/audit.js';
import { adelaideDateStamp } from '../lib/adelaideTime.js';
import { mergeId } from '../lib/merge.js';
import {
  findConvertibleKnockback,
  findDuplicateCallBackJobNumber,
  findDuplicateInvoice,
  findDuplicateNewJobNumber,
  findDuplicateUpsell,
  findOriginalBookingCall,
  findOriginalJob,
  findLatestSale,
  findSaleForInvoice,
  isTechnicianActive,
  normKey,
} from '../services/lookup.js';
import { buildJobHistoryWorkbook } from '../lib/xlsxHistory.js';

const JOB_TRACKED_FIELDS = [
  'technician_id',
  'job_number',
  'trade_id',
  'job_type_id',
  'lead',
  'inspection_sheet',
  'option_sheet',
  'knockback',
  'knockback_reason_id',
  'work_completion',
  'install_technician_id',
  'install_date',
  'comments',
  'suburb',
];
const SALE_TRACKED_FIELDS = [
  'job_number',
  'new_job_number',
  'credited_technician_id',
  'trade_id',
  'job_type_id',
  'invoice_number',
  'invoice_date',
  'sale_value_ex_gst',
  'comments',
  'suburb',
];
const CALL_BACK_TRACKED_FIELDS = [
  'job_number',
  'new_job_number',
  'attending_technician_id',
  'credited_technician_id',
  'trade_id',
  'job_type_id',
  'reason_id',
  'comments',
];
const PENDING_CANCELLATION_TRACKED_FIELDS = ['job_number', 'credited_technician_id', 'reason_id', 'comments'];

function jobRow(id) {
  return get(
    `SELECT j.*, t.name AS technician_name, it.name AS install_technician_name,
      tr.name AS trade_name, jt.name AS job_type_name, kr.name AS knockback_reason_name,
      cu.name AS created_by_name
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN technicians it ON it.id = j.install_technician_id
     LEFT JOIN trades tr ON tr.id = j.trade_id
     LEFT JOIN job_types jt ON jt.id = j.job_type_id
     LEFT JOIN list_items kr ON kr.id = j.knockback_reason_id
     LEFT JOIN users cu ON cu.id = j.created_by_user_id
     WHERE j.id = ?`,
    [id]
  );
}

function saleRow(id) {
  return get(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name,
      cu.name AS created_by_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     LEFT JOIN job_types jt ON jt.id = s.job_type_id
     LEFT JOIN users cu ON cu.id = s.created_by_user_id
     WHERE s.id = ?`,
    [id]
  );
}

function callBackRow(id) {
  return get(
    `SELECT cb.*, at.name AS attending_technician_name, ct.name AS credited_technician_name,
      tr.name AS trade_name, jt.name AS job_type_name, r.name AS reason_name,
      cu.name AS created_by_name
     FROM call_backs cb
     LEFT JOIN technicians at ON at.id = cb.attending_technician_id
     LEFT JOIN technicians ct ON ct.id = cb.credited_technician_id
     LEFT JOIN trades tr ON tr.id = cb.trade_id
     LEFT JOIN job_types jt ON jt.id = cb.job_type_id
     LEFT JOIN list_items r ON r.id = cb.reason_id
     LEFT JOIN users cu ON cu.id = cb.created_by_user_id
     WHERE cb.id = ?`,
    [id]
  );
}

// The Technician on a job is mandatory and never cleared, so it's always a
// safe, well-defined fallback for a Quote Approved Later/Call Back/Pending
// Cancellation entry's own Credited Technician whenever that field would
// otherwise end up blank — most notably when an edit clears it (mergeId()
// turns a cleared select into null, and only creation, not editing, requires
// this field to be filled in). Returns null, never guesses, when there's no
// linked job to fall back to.
function originalJobTechnicianId(jobId) {
  if (!jobId) return null;
  return get('SELECT technician_id FROM jobs WHERE id = ?', [jobId])?.technician_id || null;
}

// Call Back's own Credited (original work) Technician fallback — who
// actually completed the original work, not necessarily who's credited with
// the sale. The job itself says which: its own attending technician by
// default, or its separate Install Technician when the job's own
// "Work completion" says the work happened on a different day (falling back
// to the attending technician if no install technician was ever recorded).
// Deliberately its own function, never folded into originalJobTechnicianId()
// above — that one is relied on by Quote Approved Later/Upsell/Pending
// Cancellation for "who gets credited for the sale", which is always the
// job's own attending technician regardless of install-day nuance.
function originalWorkTechnicianId(jobId) {
  if (!jobId) return null;
  const job = get('SELECT technician_id, work_completion, install_technician_id FROM jobs WHERE id = ?', [jobId]);
  if (!job) return null;
  if (job.work_completion === 'Install scheduled — different day' && job.install_technician_id) {
    return job.install_technician_id;
  }
  return job.technician_id || null;
}

function pendingCancellationRow(id) {
  return get(
    `SELECT pc.*, t.name AS credited_technician_name, tr.name AS trade_name, r.name AS reason_name,
      cu.name AS created_by_name
     FROM pending_cancellations pc
     LEFT JOIN technicians t ON t.id = pc.credited_technician_id
     LEFT JOIN trades tr ON tr.id = pc.trade_id
     LEFT JOIN list_items r ON r.id = pc.reason_id
     LEFT JOIN users cu ON cu.id = pc.created_by_user_id
     WHERE pc.id = ?`,
    [id]
  );
}

function jobToEntry(j) {
  const sale = j.had_sale_at_visit ? get('SELECT * FROM sales WHERE job_id = ? AND source = ?', [j.id, 'sale_made_at_visit']) : null;
  return {
    kind: j.had_sale_at_visit ? 'new_job_sale_made' : 'new_job_no_sale',
    entryLabel: j.had_sale_at_visit ? 'New Job — Sale Made' : 'New Job — No Sale',
    id: j.id,
    archived: !!j.archived,
    dateShown: j.visit_date,
    visitDate: j.visit_date,
    technicianId: j.technician_id,
    technicianName: j.technician_name,
    // Who actually completed the work — the attending technician normally,
    // or the separate Install Technician when Work Completion says the job
    // was finished on a different day (never a guess: falls back to the
    // attending technician if no install technician was ever recorded).
    // Used by the "Technician who completed the work" filter.
    completingTechnicianId:
      j.work_completion === 'Install scheduled — different day' && j.install_technician_id ? j.install_technician_id : j.technician_id,
    jobNumber: j.job_number,
    tradeId: j.trade_id,
    tradeName: j.trade_name,
    jobTypeId: j.job_type_id,
    jobTypeName: j.job_type_name,
    lead: j.lead,
    inspectionSheet: j.inspection_sheet,
    optionSheet: j.option_sheet,
    knockback: !!j.knockback,
    knockbackReasonId: j.knockback_reason_id,
    knockbackReasonName: j.knockback_reason_name,
    convertedLater: !!j.converted_later,
    workCompletion: j.work_completion,
    installTechnicianId: j.install_technician_id,
    installTechnicianName: j.install_technician_name,
    installDate: j.install_date,
    invoiceNumber: sale?.invoice_number || '',
    invoiceDate: sale?.invoice_date || '',
    saleValueExGst: sale?.sale_value_ex_gst ?? '',
    comments: j.comments,
    suburb: j.suburb || '',
    createdByUserId: j.created_by_user_id,
    createdByName: j.created_by_name || '',
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

function saleToEntry(s) {
  return {
    kind: s.is_upsell ? 'existing_job_upsell' : 'quote_approved_later',
    entryLabel: s.is_upsell ? 'Existing Job — Upsell' : 'Existing Job — Quote Approved Later',
    id: s.id,
    archived: !!s.archived,
    dateShown: s.date_logged,
    technicianId: s.credited_technician_id,
    technicianName: s.credited_technician_name,
    creditedTechnicianId: s.credited_technician_id,
    creditedTechnicianName: s.credited_technician_name,
    // Who gets credited for this work — always the credited technician for
    // a sale row. Used by the "Technician who completed the work" filter.
    completingTechnicianId: s.credited_technician_id,
    // The *original* visit's Job Number — used for matching/linking/
    // attribution (see /quote-approved-later and /existing-job-upsell
    // below). Distinct from newJobNumber, the separate AroFlo JN created for
    // the approved work on a true Quote Approved Later — never populated for
    // an Upsell, which has no such second JN.
    jobNumber: s.job_number,
    newJobNumber: s.new_job_number || '',
    tradeId: s.trade_id,
    tradeName: s.trade_name,
    jobTypeId: s.job_type_id,
    jobTypeName: s.job_type_name,
    invoiceNumber: s.invoice_number,
    invoiceDate: s.invoice_date,
    saleValueExGst: s.sale_value_ex_gst,
    // Only ever populated for an Upsell (its own, independently-editable
    // copy of the original job's suburb) — blank for every other source,
    // same convention as newJobNumber above.
    suburb: s.suburb || '',
    comments: s.comments,
    createdByUserId: s.created_by_user_id,
    createdByName: s.created_by_name || '',
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function callBackToEntry(cb) {
  return {
    kind: 'call_back',
    entryLabel: 'Call Back',
    id: cb.id,
    archived: !!cb.archived,
    dateShown: cb.visit_date,
    visitDate: cb.visit_date,
    technicianId: cb.attending_technician_id,
    technicianName: cb.attending_technician_name,
    creditedTechnicianId: cb.credited_technician_id,
    creditedTechnicianName: cb.credited_technician_name,
    // "Who completed the work" for a Call Back is its own Credited
    // (original work) Technician — already specifically chosen for this
    // reason (see originalWorkTechnicianId()), never the Attending
    // Technician, who is simply whoever is attending THIS callback visit.
    completingTechnicianId: cb.credited_technician_id,
    // The ORIGINAL job's Job Number — used for matching/linking (see
    // /call-backs below). Distinct from newJobNumber, the separate AroFlo JN
    // created once the callback attendance is actually booked.
    jobNumber: cb.job_number,
    newJobNumber: cb.new_job_number || '',
    // Set only when job_number actually matched an existing job at save time
    // — used purely so the UI can offer a "View original job" link; never
    // itself written to or read for any figure.
    jobId: cb.job_id || null,
    tradeId: cb.trade_id,
    tradeName: cb.trade_name,
    jobTypeId: cb.job_type_id,
    jobTypeName: cb.job_type_name,
    reasonId: cb.reason_id,
    reasonName: cb.reason_name,
    comments: cb.comments,
    createdByUserId: cb.created_by_user_id,
    createdByName: cb.created_by_name || '',
    createdAt: cb.created_at,
    updatedAt: cb.updated_at,
  };
}

function pendingCancellationToEntry(pc) {
  return {
    kind: 'pending_cancellation',
    entryLabel: 'Pending Cancellation',
    id: pc.id,
    archived: !!pc.archived,
    dateShown: pc.date_logged,
    technicianId: pc.credited_technician_id,
    technicianName: pc.credited_technician_name,
    creditedTechnicianId: pc.credited_technician_id,
    creditedTechnicianName: pc.credited_technician_name,
    completingTechnicianId: pc.credited_technician_id,
    jobNumber: pc.job_number,
    tradeId: pc.trade_id,
    tradeName: pc.trade_name,
    reasonId: pc.reason_id,
    reasonName: pc.reason_name,
    comments: pc.comments,
    createdByUserId: pc.created_by_user_id,
    createdByName: pc.created_by_name || '',
    createdAt: pc.created_at,
    updatedAt: pc.updated_at,
  };
}

const ENTITY_TYPE_BY_KIND = {
  new_job_no_sale: 'job',
  new_job_sale_made: 'job',
  quote_approved_later: 'sale',
  existing_job_upsell: 'sale',
  call_back: 'call_back',
  pending_cancellation: 'pending_cancellation',
};

// `status` ('active' | 'archived' | 'all') is the tri-state Active/archived
// filter the Advanced Filters panel uses — it takes priority over the older
// `includeArchived` boolean (kept working unchanged for existing callers).
export function listTechEntries({
  from,
  to,
  technicianId,
  tradeId,
  jobTypeId,
  entryType,
  jobNumber,
  originalJobNumber,
  newJobNumber,
  suburb,
  completingTechnicianId,
  saleMade,
  knockback,
  knockbackReasonId,
  workCompletion,
  convertedLater,
  hasCallBack,
  hasPendingCancellation,
  hasUpsell,
  createdByUserId,
  status,
  q,
  includeArchived,
} = {}) {
  const showArchived = includeArchived === 'true';

    let entries = [
      ...all(`SELECT j.*, t.name AS technician_name, it.name AS install_technician_name, tr.name AS trade_name,
                jt.name AS job_type_name, kr.name AS knockback_reason_name, cu.name AS created_by_name
              FROM jobs j
              LEFT JOIN technicians t ON t.id = j.technician_id
              LEFT JOIN technicians it ON it.id = j.install_technician_id
              LEFT JOIN trades tr ON tr.id = j.trade_id
              LEFT JOIN job_types jt ON jt.id = j.job_type_id
              LEFT JOIN list_items kr ON kr.id = j.knockback_reason_id
              LEFT JOIN users cu ON cu.id = j.created_by_user_id`).map(jobToEntry),
      ...all(`SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name,
                cu.name AS created_by_name
              FROM sales s
              LEFT JOIN technicians t ON t.id = s.credited_technician_id
              LEFT JOIN trades tr ON tr.id = s.trade_id
              LEFT JOIN job_types jt ON jt.id = s.job_type_id
              LEFT JOIN users cu ON cu.id = s.created_by_user_id
              WHERE s.source = 'quote_approved_later'`).map(saleToEntry),
      ...all(`SELECT cb.*, at.name AS attending_technician_name, ct.name AS credited_technician_name,
                tr.name AS trade_name, jt.name AS job_type_name, r.name AS reason_name, cu.name AS created_by_name
              FROM call_backs cb
              LEFT JOIN technicians at ON at.id = cb.attending_technician_id
              LEFT JOIN technicians ct ON ct.id = cb.credited_technician_id
              LEFT JOIN trades tr ON tr.id = cb.trade_id
              LEFT JOIN job_types jt ON jt.id = cb.job_type_id
              LEFT JOIN list_items r ON r.id = cb.reason_id
              LEFT JOIN users cu ON cu.id = cb.created_by_user_id`).map(callBackToEntry),
      ...all(`SELECT pc.*, t.name AS credited_technician_name, tr.name AS trade_name, r.name AS reason_name,
                cu.name AS created_by_name
              FROM pending_cancellations pc
              LEFT JOIN technicians t ON t.id = pc.credited_technician_id
              LEFT JOIN trades tr ON tr.id = pc.trade_id
              LEFT JOIN list_items r ON r.id = pc.reason_id
              LEFT JOIN users cu ON cu.id = pc.created_by_user_id`).map(pendingCancellationToEntry),
    ];

    if (status === 'archived') entries = entries.filter((e) => e.archived);
    else if (status === 'all') {
      // no archived filter — every record regardless of status
    } else if (status === 'active') entries = entries.filter((e) => !e.archived);
    else if (!showArchived) entries = entries.filter((e) => !e.archived);
    if (from) entries = entries.filter((e) => (e.dateShown || '') >= from);
    if (to) entries = entries.filter((e) => (e.dateShown || '') <= to);
    if (technicianId) {
      const tid = Number(technicianId);
      entries = entries.filter((e) => e.technicianId === tid || e.creditedTechnicianId === tid);
    }
    if (tradeId) entries = entries.filter((e) => e.tradeId === Number(tradeId));
    if (jobTypeId) entries = entries.filter((e) => e.jobTypeId === Number(jobTypeId));
    if (entryType) entries = entries.filter((e) => e.kind === entryType);
    // Matches either JN on a Quote Approved Later or Call Back entry — the
    // original job number it's linked against, or its own separate New Job
    // Number — so a search for either one locates the same entry. This is
    // the combined "Job number" quick filter; originalJobNumber/newJobNumber
    // below are the Advanced Filters panel's own, more precise pair.
    if (jobNumber) {
      const key = normKey(jobNumber);
      entries = entries.filter((e) => normKey(e.jobNumber) === key || (e.newJobNumber && normKey(e.newJobNumber) === key));
    }
    if (originalJobNumber) {
      const key = normKey(originalJobNumber);
      entries = entries.filter((e) => normKey(e.jobNumber) === key);
    }
    if (newJobNumber) {
      const key = normKey(newJobNumber);
      entries = entries.filter((e) => e.newJobNumber && normKey(e.newJobNumber) === key);
    }
    if (suburb) {
      const key = normKey(suburb);
      entries = entries.filter((e) => normKey(e.suburb) === key);
    }
    if (completingTechnicianId) {
      const tid = Number(completingTechnicianId);
      entries = entries.filter((e) => e.completingTechnicianId === tid);
    }
    if (createdByUserId) {
      const uid = Number(createdByUserId);
      entries = entries.filter((e) => e.createdByUserId === uid);
    }
    // Sale Made: Yes/No — whether this record carries an invoice at all,
    // regardless of entry kind (a New Job — Sale Made, a Quote Approved
    // Later, and an Upsell all carry one; a No Sale job, Call Back and
    // Pending Cancellation never do).
    if (saleMade === 'yes') entries = entries.filter((e) => !!e.invoiceNumber);
    else if (saleMade === 'no') entries = entries.filter((e) => !e.invoiceNumber);
    const isJobKind = (e) => e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made';
    // Knockback/Converted Later/Call Back/Pending Cancellation/Upsell below
    // are all concepts that only ever apply to a New Job entry — "No" is
    // scoped to job-kind rows explicitly (never silently pulling in an
    // unrelated Call Back/Quote Approved Later/etc. row just because it
    // trivially doesn't have the flag either).
    if (knockback === 'yes') entries = entries.filter((e) => e.knockback === true);
    else if (knockback === 'no') entries = entries.filter((e) => isJobKind(e) && e.knockback === false);
    if (knockbackReasonId) entries = entries.filter((e) => Number(e.knockbackReasonId) === Number(knockbackReasonId));
    if (workCompletion) entries = entries.filter((e) => e.workCompletion === workCompletion);
    if (convertedLater === 'yes') entries = entries.filter((e) => e.convertedLater === true);
    else if (convertedLater === 'no') entries = entries.filter((e) => isJobKind(e) && e.convertedLater === false);
    // hasCallBack/hasPendingCancellation/hasUpsell are filtered further down,
    // after relatedCallBackCount/relatedPendingCancellationCount/
    // relatedUpsellCount are computed below — those need a DB lookup per
    // entry, so (like historyCount) they're only ever computed once, after
    // every other filter has already narrowed the set down.
    // Free-text keyword search — job number (either JN), suburb and
    // comments, the only free-text fields these records actually carry
    // (there is no customer name or phone number stored anywhere here).
    if (q && String(q).trim()) {
      const key = String(q).trim().toLowerCase();
      entries = entries.filter(
        (e) =>
          (e.jobNumber || '').toLowerCase().includes(key) ||
          (e.newJobNumber || '').toLowerCase().includes(key) ||
          (e.suburb || '').toLowerCase().includes(key) ||
          (e.comments || '').toLowerCase().includes(key)
      );
    }

  entries.sort((a, b) => (b.dateShown || '').localeCompare(a.dateShown || '') || b.id - a.id);

  const idsByType = {};
  entries.forEach((e) => {
    const t = ENTITY_TYPE_BY_KIND[e.kind];
    (idsByType[t] ||= []).push(e.id);
  });
  const countsByType = {};
  const lastEditedByType = {};
  Object.entries(idsByType).forEach(([t, ids]) => {
    countsByType[t] = getHistoryCounts(t, ids);
    lastEditedByType[t] = getLastEditedInfo(t, ids);
  });
  // A job row can't be deleted while a sales row still references it by
  // job_id (always true for "New Job — Sale Made", and also true for a
  // knock-back job once a later "Quote Approved Later" sale converts it) —
  // and a "Quote Approved Later" sale can't be deleted while it's the sale a
  // job's converted_by_sale_id points back to. Neither Delete button should
  // be offered in those cases; Archive is always safe regardless.
  const jobIdsWithSales = new Set(all("SELECT DISTINCT job_id AS id FROM sales WHERE job_id IS NOT NULL").map((r) => r.id));
  const saleIdsConvertedFrom = new Set(all("SELECT DISTINCT converted_by_sale_id AS id FROM jobs WHERE converted_by_sale_id IS NOT NULL").map((r) => r.id));

  entries.forEach((e) => {
    const t = ENTITY_TYPE_BY_KIND[e.kind];
    e.historyCount = countsByType[t]?.[e.id] || 0;
    const le = lastEditedByType[t]?.[e.id];
    e.lastEditedByName = le?.by || '';
    e.lastEditedAt = le?.at || '';
    e.relatedCallsCount = e.jobNumber
      ? get('SELECT COUNT(*) AS n FROM calls WHERE archived = 0 AND lower(trim(job_number)) = ?', [normKey(e.jobNumber)]).n
      : 0;
    const isJobEntry = e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made';
    // Only a New Job entry can have a linked Call Back/Pending Cancellation/
    // Upsell pointing back at it (by Original Job Number) — used both for
    // the "has one? Yes/No" filters below and to offer "View linked
    // callback"-style links in the UI, mirroring relatedCallsCount above.
    e.relatedCallBackCount =
      isJobEntry && e.jobNumber
        ? get('SELECT COUNT(*) AS n FROM call_backs WHERE archived = 0 AND lower(trim(job_number)) = ?', [normKey(e.jobNumber)]).n
        : 0;
    e.relatedPendingCancellationCount =
      isJobEntry && e.jobNumber
        ? get('SELECT COUNT(*) AS n FROM pending_cancellations WHERE archived = 0 AND lower(trim(job_number)) = ?', [normKey(e.jobNumber)]).n
        : 0;
    e.relatedUpsellCount =
      isJobEntry && e.jobNumber
        ? get("SELECT COUNT(*) AS n FROM sales WHERE archived = 0 AND is_upsell = 1 AND lower(trim(job_number)) = ?", [normKey(e.jobNumber)]).n
        : 0;
    if (e.kind === 'quote_approved_later') e.canDelete = !saleIdsConvertedFrom.has(e.id);
    else if (isJobEntry) e.canDelete = !jobIdsWithSales.has(e.id);
    // An Upsell never flips a knock-back to converted (see findConvertibleKnockback's
    // callers below — it's never called for this entry type), so it can
    // never be the sale a job's converted_by_sale_id points back to.
    else if (e.kind === 'existing_job_upsell') e.canDelete = true;
    else e.canDelete = true;
  });

  // Deferred from the main filter block above — these three need
  // relatedCallBackCount/relatedPendingCancellationCount/relatedUpsellCount,
  // only just computed. Scoped the same way as Knockback/Converted Later
  // above: "No" only ever matches a job-kind row explicitly, never an
  // unrelated Call Back/Quote Approved Later/etc. row.
  const isJobKindEntry = (e) => e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made';
  if (hasCallBack === 'yes') entries = entries.filter((e) => e.relatedCallBackCount > 0);
  else if (hasCallBack === 'no') entries = entries.filter((e) => isJobKindEntry(e) && e.relatedCallBackCount === 0);
  if (hasPendingCancellation === 'yes') entries = entries.filter((e) => e.relatedPendingCancellationCount > 0);
  else if (hasPendingCancellation === 'no') entries = entries.filter((e) => isJobKindEntry(e) && e.relatedPendingCancellationCount === 0);
  if (hasUpsell === 'yes') entries = entries.filter((e) => e.relatedUpsellCount > 0);
  else if (hasUpsell === 'no') entries = entries.filter((e) => isJobKindEntry(e) && e.relatedUpsellCount === 0);

  return entries;
}

export function createTechSalesRouter() {
  const router = Router();
  router.use(requireAuth);

  // ---- Unified job history feed ----
  router.get('/entries', (req, res) => {
    res.json(listTechEntries(req.query));
  });

  router.get('/entries/export.xlsx', async (req, res) => {
    const rows = listTechEntries(req.query);
    const lookups = {
      technicians: new Map(all('SELECT id, name FROM technicians').map((t) => [String(t.id), t.name])),
      trades: new Map(all('SELECT id, name FROM trades').map((t) => [String(t.id), t.name])),
      jobTypes: new Map(all('SELECT id, name FROM job_types').map((t) => [String(t.id), t.name])),
      staff: new Map(all('SELECT id, name FROM users').map((u) => [String(u.id), u.name])),
      knockbackReasons: new Map(all("SELECT id, name FROM list_items WHERE category = 'knockback_reason'").map((r) => [String(r.id), r.name])),
    };
    const wb = buildJobHistoryWorkbook(rows, req.query, lookups);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="technician-sales-history-${adelaideDateStamp()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  router.get('/entries/:kind/:id/history', (req, res) => {
    const entityType = ENTITY_TYPE_BY_KIND[req.params.kind];
    if (!entityType) return res.status(404).json({ error: 'Unknown entry kind.' });
    res.json(getHistory(entityType, req.params.id));
  });

  // ---- New Job (No Sale / Sale Made) ----
  router.post('/new-job', (req, res) => {
    const b = req.body || {};
    const isSaleMade = b.kind === 'new_job_sale_made';

    // Visit Date, Technician, Job Number, Trade, Job Type and Lead status are
    // mandatory on every brand-new "New Job" entry (No Sale or Sale Made) —
    // backend backstop for the same check the client enforces, since Total
    // Jobs/Qualified Jobs/Knock-back %/Conversion Rate/Average Sale and the
    // job-number lookups used elsewhere all depend on these being filled in.
    // Checked only here, on creation; editing an existing entry (PATCH
    // below) is never blocked by this, so an older record missing one of
    // these can still be edited without being forced to fill in a value it
    // never recorded.
    const missing = [];
    if (!b.visitDate) missing.push('Visit Date');
    if (!b.technicianId) missing.push('Technician');
    if (!b.jobNumber || !String(b.jobNumber).trim()) missing.push('Job Number');
    if (!b.tradeId) missing.push('Trade');
    if (!b.jobTypeId) missing.push('Job Type');
    if (b.lead !== 'Qualified' && b.lead !== 'Not Qualified') missing.push('Lead status (Qualified or Unqualified)');
    if (missing.length) {
      return res.status(400).json({
        error: `Please complete the following required field${missing.length > 1 ? 's' : ''} before saving: ${missing.join(', ')}.`,
      });
    }
    if (!isTechnicianActive(b.technicianId)) {
      return res.status(400).json({ error: 'This technician has been deactivated and cannot be assigned to a new job.' });
    }
    if (isSaleMade && b.installTechnicianId && !isTechnicianActive(b.installTechnicianId)) {
      return res.status(400).json({ error: 'The selected install technician has been deactivated and cannot be assigned to a new job.' });
    }

    // A brand-new job with a Job Number that's already in use by another
    // active job is almost always a follow-up visit, not a genuinely new
    // job — "Existing Job — Quote Approved Later" and "Call Back" both exist
    // for that, so this is blocked rather than silently creating a second,
    // conflicting job on the same JN.
    const existingJobForJn = findOriginalJob(b.jobNumber);
    if (existingJobForJn) {
      return res.status(400).json({
        error: `Job Number ${b.jobNumber} already exists (logged ${existingJobForJn.visit_date}${
          existingJobForJn.trade_name ? ` — ${existingJobForJn.trade_name}` : ''
        }). If this is a follow-up on that job, use "Existing Job — Quote Approved Later" or "Call Back" instead of creating a new job.`,
      });
    }

    // A No Sale entry is only a genuine knock-back when the lead was
    // Qualified — an Unqualified lead was never a real sales opportunity, so
    // it must never be auto-flagged (or later auto-converted by a Quote
    // Approved Later sale) as one.
    const isGenuineKnockback = !isSaleMade && b.lead === 'Qualified';
    if (isGenuineKnockback) {
      if (!b.knockbackReasonId) {
        return res.status(400).json({ error: 'Please select a Reason for Knockback before saving.' });
      }
      const reason = get('SELECT name FROM list_items WHERE id = ?', [b.knockbackReasonId]);
      if (reason?.name === 'Other' && !(b.comments || '').trim()) {
        return res.status(400).json({ error: 'Please add a brief explanation in Additional Comments when Reason for Knockback is "Other".' });
      }
    }

    let notice = null;

    if (isSaleMade && b.invoiceNumber) {
      const dupe = findDuplicateInvoice(b.invoiceNumber);
      if (dupe) notice = `Heads up: invoice ${b.invoiceNumber} already exists on JN ${dupe.job_number}. If this is the same invoice, edit that entry instead — duplicate invoice numbers are only counted once in reports.`;
    }

    const result = transaction(() => {
      const jobValues = {
        technician_id: b.technicianId || null,
        job_number: b.jobNumber || '',
        trade_id: b.tradeId || null,
        job_type_id: b.jobTypeId || null,
        lead: b.lead || '',
        inspection_sheet: b.inspectionSheet || '',
        option_sheet: b.optionSheet || '',
        knockback: isGenuineKnockback ? 1 : 0,
        knockback_reason_id: isSaleMade ? null : b.knockbackReasonId || null,
        work_completion: isSaleMade ? b.workCompletion || '' : '',
        install_technician_id: isSaleMade ? b.installTechnicianId || null : null,
        install_date: isSaleMade ? b.installDate || '' : '',
        comments: b.comments || '',
        // An explicit value always wins; otherwise fall back to the earliest
        // Calls & Contacts record sharing this Job Number (the linked/
        // original booking, never a later, unrelated contact) — the same
        // backend backstop pattern already used for Trade/Job Type on
        // Quote Approved Later and Call Back, so this is never dependent on
        // the client having actually run that lookup itself.
        suburb: b.suburb || findOriginalBookingCall(b.jobNumber)?.suburb || '',
      };
      const { lastInsertRowid: jobId } = run(
        `INSERT INTO jobs (job_number, visit_date, technician_id, trade_id, job_type_id, lead, inspection_sheet,
          option_sheet, had_sale_at_visit, knockback, knockback_reason_id, work_completion, install_technician_id,
          install_date, comments, suburb, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobValues.job_number,
          b.visitDate,
          jobValues.technician_id,
          jobValues.trade_id,
          jobValues.job_type_id,
          jobValues.lead,
          jobValues.inspection_sheet,
          jobValues.option_sheet,
          isSaleMade ? 1 : 0,
          jobValues.knockback,
          jobValues.knockback_reason_id,
          jobValues.work_completion,
          jobValues.install_technician_id,
          jobValues.install_date,
          jobValues.comments,
          jobValues.suburb,
          req.user.id,
        ]
      );
      recordAudit({ entityType: 'job', entityId: jobId, before: null, after: jobValues, fields: JOB_TRACKED_FIELDS, userId: req.user.id });
      if (isSaleMade) {
        const saleValues = {
          job_number: b.jobNumber || '',
          credited_technician_id: b.technicianId || null,
          invoice_number: b.invoiceNumber || '',
          invoice_date: b.invoiceDate || '',
          sale_value_ex_gst: Number(b.saleValueExGst) || 0,
          comments: b.comments || '',
        };
        const { lastInsertRowid: saleId } = run(
          `INSERT INTO sales (job_id, job_number, source, date_logged, credited_technician_id, trade_id, job_type_id,
            invoice_number, invoice_date, sale_value_ex_gst, comments, created_by_user_id)
           VALUES (?, ?, 'sale_made_at_visit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jobId,
            saleValues.job_number,
            b.visitDate,
            saleValues.credited_technician_id,
            jobValues.trade_id,
            jobValues.job_type_id,
            saleValues.invoice_number,
            saleValues.invoice_date,
            saleValues.sale_value_ex_gst,
            saleValues.comments,
            req.user.id,
          ]
        );
        recordAudit({ entityType: 'sale', entityId: saleId, before: null, after: saleValues, fields: SALE_TRACKED_FIELDS, userId: req.user.id });
      }
      return jobId;
    });

    res.status(201).json({ entry: jobToEntry(jobRow(result)), notice });
  });

  router.patch('/new-job/:id', (req, res) => {
    const existing = jobRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    const isSaleMade = !!existing.had_sale_at_visit;

    const next = {
      technician_id: mergeId(b.technicianId, existing.technician_id),
      job_number: b.jobNumber ?? existing.job_number,
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      lead: b.lead ?? existing.lead,
      inspection_sheet: b.inspectionSheet ?? existing.inspection_sheet,
      option_sheet: b.optionSheet ?? existing.option_sheet,
      knockback: existing.knockback,
      knockback_reason_id: isSaleMade ? null : mergeId(b.knockbackReasonId, existing.knockback_reason_id),
      work_completion: isSaleMade ? b.workCompletion ?? existing.work_completion : '',
      install_technician_id: isSaleMade ? mergeId(b.installTechnicianId, existing.install_technician_id) : null,
      install_date: isSaleMade ? b.installDate ?? existing.install_date : '',
      comments: b.comments ?? existing.comments,
      suburb: b.suburb ?? existing.suburb,
    };
    const visitDate = b.visitDate ?? existing.visit_date;

    transaction(() => {
      run(
        `UPDATE jobs SET technician_id=?, job_number=?, visit_date=?, trade_id=?, job_type_id=?, lead=?,
          inspection_sheet=?, option_sheet=?, knockback_reason_id=?, work_completion=?, install_technician_id=?,
          install_date=?, comments=?, suburb=?, updated_at=datetime('now') WHERE id=?`,
        [
          next.technician_id,
          next.job_number,
          visitDate,
          next.trade_id,
          next.job_type_id,
          next.lead,
          next.inspection_sheet,
          next.option_sheet,
          next.knockback_reason_id,
          next.work_completion,
          next.install_technician_id,
          next.install_date,
          next.comments,
          next.suburb,
          req.params.id,
        ]
      );
      if (isSaleMade && (b.invoiceNumber !== undefined || b.invoiceDate !== undefined || b.saleValueExGst !== undefined)) {
        const sale = get('SELECT * FROM sales WHERE job_id = ? AND source = ?', [req.params.id, 'sale_made_at_visit']);
        if (sale) {
          run('UPDATE sales SET invoice_number=?, invoice_date=?, sale_value_ex_gst=?, job_number=?, trade_id=?, updated_at=datetime(\'now\') WHERE id=?', [
            b.invoiceNumber ?? sale.invoice_number,
            b.invoiceDate ?? sale.invoice_date,
            b.saleValueExGst !== undefined ? Number(b.saleValueExGst) || 0 : sale.sale_value_ex_gst,
            next.job_number,
            next.trade_id,
            sale.id,
          ]);
        }
      }
    });

    recordAudit({ entityType: 'job', entityId: Number(req.params.id), before: existing, after: next, fields: JOB_TRACKED_FIELDS, userId: req.user.id });
    res.json(jobToEntry(jobRow(req.params.id)));
  });

  // ---- Existing Job — Quote Approved Later ----
  router.post('/quote-approved-later', (req, res) => {
    const b = req.body || {};
    // Both JNs are required on every brand-new entry — Original Job Number
    // to locate/link the original visit (and drive technician/trade/job-type
    // attribution below), New Job Number as the separate AroFlo JN created
    // for the approved work. Checked only here, on creation; editing an
    // existing entry (PATCH below) is never blocked by this, so a legacy
    // record saved with only one JN can still be edited without being forced
    // to fill in a New Job Number it never recorded.
    const missing = [];
    if (!b.jobNumber || !String(b.jobNumber).trim()) missing.push('Original Job Number');
    if (!b.newJobNumber || !String(b.newJobNumber).trim()) missing.push('New Job Number');
    // Credited Technician drives every Technician & Sales report figure this
    // entry counts towards — mandatory on creation (never on edit, so a
    // legacy entry saved before this check existed can still be edited)
    // so it can never silently fall into an "Unassigned" bucket.
    if (!b.creditedTechnicianId) missing.push('Credited Technician');
    if (missing.length) {
      return res.status(400).json({
        error: `Please complete the following required field${missing.length > 1 ? 's' : ''} before saving: ${missing.join(', ')}.`,
      });
    }
    // "Existing Job — Quote Approved Later" only ever makes sense against a
    // job that's actually on record — the Original Job Number must match by
    // exact Job Number (never a partial/fuzzy match, so it can never link to
    // the wrong job), and is blocked entirely rather than saved half-linked
    // if nothing matches.
    const matchedJob = findOriginalJob(b.jobNumber);
    if (!matchedJob) {
      return res.status(400).json({
        error: `No existing job found for Original Job Number ${b.jobNumber}. "Existing Job — Quote Approved Later" must reference a Job Number that was already logged as a New Job entry.`,
      });
    }
    // The New Job Number is AroFlo's own, freshly created for the approved
    // work — it must never be reused across more than one Quote Approved
    // Later entry, but this check is scoped to that entry type alone (see
    // findDuplicateNewJobNumber), so it can never block some other,
    // unrelated record from legitimately referencing that same JN later.
    const dupeNewJn = findDuplicateNewJobNumber(b.newJobNumber);
    if (dupeNewJn) {
      return res.status(400).json({
        error: `New Job Number ${b.newJobNumber} is already used on another Quote Approved Later entry (Original JN ${dupeNewJn.job_number}). Each New Job Number can only be used once.`,
      });
    }

    let notice = null;
    if (b.invoiceNumber) {
      const dupe = findDuplicateInvoice(b.invoiceNumber);
      if (dupe) notice = `Heads up: invoice ${b.invoiceNumber} already exists on JN ${dupe.job_number}. If this is the same invoice, edit that entry instead — duplicate invoice numbers are only counted once in reports.`;
    }

    const saleId = transaction(() => {
      // The original job's Technician, Trade and Job Type are auto-populated
      // below where possible, but stay editable — an explicit value in the
      // request always wins over the matched job's own value. New Job
      // Number is stored alongside, purely for reference/search — it never
      // touches job_id (the original job's link) and never creates or
      // affects any job row.
      const saleValues = {
        job_number: b.jobNumber || '',
        new_job_number: b.newJobNumber || '',
        credited_technician_id: b.creditedTechnicianId || null,
        trade_id: b.tradeId || matchedJob.trade_id || null,
        job_type_id: b.jobTypeId || matchedJob.job_type_id || null,
        invoice_number: b.invoiceNumber || '',
        invoice_date: b.invoiceDate || '',
        sale_value_ex_gst: Number(b.saleValueExGst) || 0,
        comments: b.comments || '',
      };
      const { lastInsertRowid } = run(
        `INSERT INTO sales (job_id, job_number, new_job_number, source, date_logged, credited_technician_id, trade_id, job_type_id,
          invoice_number, invoice_date, sale_value_ex_gst, comments, created_by_user_id)
         VALUES (?, ?, ?, 'quote_approved_later', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          matchedJob.id,
          saleValues.job_number,
          saleValues.new_job_number,
          b.dateLogged,
          saleValues.credited_technician_id,
          saleValues.trade_id,
          saleValues.job_type_id,
          saleValues.invoice_number,
          saleValues.invoice_date,
          saleValues.sale_value_ex_gst,
          saleValues.comments,
          req.user.id,
        ]
      );
      recordAudit({ entityType: 'sale', entityId: lastInsertRowid, before: null, after: saleValues, fields: SALE_TRACKED_FIELDS, userId: req.user.id });

      const flip = findConvertibleKnockback(b.jobNumber);
      if (flip) {
        run("UPDATE jobs SET converted_later = 1, converted_by_sale_id = ?, updated_at = datetime('now') WHERE id = ?", [lastInsertRowid, flip.id]);
        recordAudit({
          entityType: 'job',
          entityId: flip.id,
          before: { knockback: 'Yes' },
          after: { knockback: 'Converted (quote approved later)' },
          fields: ['knockback'],
          userId: req.user.id,
        });
      }
      return lastInsertRowid;
    });

    res.status(201).json({ entry: saleToEntry(saleRow(saleId)), notice });
  });

  router.patch('/quote-approved-later/:id', (req, res) => {
    // is_upsell = 0 so this route can never be used to edit an Upsell entry
    // (which shares the same `source` value) — see /existing-job-upsell/:id
    // below for that row's own edit route.
    const existing = get('SELECT * FROM sales WHERE id = ? AND source = ? AND is_upsell = 0', [req.params.id, 'quote_approved_later']);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    // Editing is never blocked by the "must match" or "both required" rules
    // that only apply to creation — this is exactly how a legacy record
    // (New Job Number blank) picks one up later without disturbing its
    // existing link (job_id is never touched here, on create or edit).
    if (b.newJobNumber !== undefined && String(b.newJobNumber).trim()) {
      const dupeNewJn = findDuplicateNewJobNumber(b.newJobNumber, req.params.id);
      if (dupeNewJn) {
        return res.status(400).json({
          error: `New Job Number ${b.newJobNumber} is already used on another Quote Approved Later entry (Original JN ${dupeNewJn.job_number}). Each New Job Number can only be used once.`,
        });
      }
    }
    const next = {
      job_number: b.jobNumber ?? existing.job_number,
      new_job_number: b.newJobNumber ?? existing.new_job_number,
      // Credited Technician is only mandatory on creation — an edit that
      // clears it (e.g. a select reset to blank) would otherwise silently
      // save null, which is exactly how a "Converted Later" entry could end
      // up with no technician assigned despite that rule. Falling back to
      // the original job's own (always-present) technician — never a guess,
      // and never applied when an explicit value is given — means this can
      // no longer happen.
      credited_technician_id: mergeId(b.creditedTechnicianId, existing.credited_technician_id) || originalJobTechnicianId(existing.job_id),
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      invoice_number: b.invoiceNumber ?? existing.invoice_number,
      invoice_date: b.invoiceDate ?? existing.invoice_date,
      sale_value_ex_gst: b.saleValueExGst !== undefined ? Number(b.saleValueExGst) || 0 : existing.sale_value_ex_gst,
      comments: b.comments ?? existing.comments,
    };
    const dateLogged = b.dateLogged ?? existing.date_logged;
    run(
      `UPDATE sales SET job_number=?, new_job_number=?, date_logged=?, credited_technician_id=?, trade_id=?, job_type_id=?, invoice_number=?, invoice_date=?,
        sale_value_ex_gst=?, comments=?, updated_at=datetime('now') WHERE id=?`,
      [
        next.job_number,
        next.new_job_number,
        dateLogged,
        next.credited_technician_id,
        next.trade_id,
        next.job_type_id,
        next.invoice_number,
        next.invoice_date,
        next.sale_value_ex_gst,
        next.comments,
        req.params.id,
      ]
    );
    recordAudit({ entityType: 'sale', entityId: Number(req.params.id), before: existing, after: next, fields: SALE_TRACKED_FIELDS, userId: req.user.id });
    res.json(saleToEntry(saleRow(req.params.id)));
  });

  // ---- Existing Job — Upsell ----
  // A different technician adding extra work onto a job's EXISTING invoice —
  // never a new invoice, never a new job. Deliberately its own route rather
  // than a variant of Quote Approved Later above: it must never trigger that
  // flow's "flip a knock-back to converted" behaviour (findConvertibleKnockback
  // is never called below) and must link against an invoice ALREADY on
  // record, not a freely-entered one.
  router.post('/existing-job-upsell', (req, res) => {
    const b = req.body || {};
    const missing = [];
    if (!b.jobNumber || !String(b.jobNumber).trim()) missing.push('Job Number');
    if (!b.invoiceNumber || !String(b.invoiceNumber).trim()) missing.push('Invoice Number');
    // Credited Technician is who actually made the upsell — mandatory on
    // creation (never on edit, matching every other entry type here) so it
    // can never silently fall into an "Unassigned" bucket in reports.
    if (!b.creditedTechnicianId) missing.push('Credited Technician');
    if (missing.length) {
      return res.status(400).json({
        error: `Please complete the following required field${missing.length > 1 ? 's' : ''} before saving: ${missing.join(', ')}.`,
      });
    }
    // Must reference a job that's actually on record — exact Job Number
    // match only, same rule as Quote Approved Later above.
    const matchedJob = findOriginalJob(b.jobNumber);
    if (!matchedJob) {
      return res.status(400).json({
        error: `No existing job found for Job Number ${b.jobNumber}. "Existing Job — Upsell" must reference a Job Number that was already logged as a New Job entry.`,
      });
    }
    // Must reference an invoice that's actually on record for that job — an
    // Upsell adds value onto an EXISTING invoice, never a new one. Excludes
    // other Upsell rows (see findSaleForInvoice): it must link to the
    // genuine original sale, not another upsell that happens to share the
    // same invoice number.
    const matchedSale = findSaleForInvoice(b.jobNumber, b.invoiceNumber);
    if (!matchedSale) {
      return res.status(400).json({
        error: `No existing invoice ${b.invoiceNumber} found for Job Number ${b.jobNumber}. "Existing Job — Upsell" must reference an invoice that's already on record for that job.`,
      });
    }
    // Duplicate protection: the exact same upsell (same job, same invoice,
    // same technician) accidentally entered twice. A different technician,
    // or the same technician on a different invoice/date for this job, is
    // never blocked by this.
    const dupeUpsell = findDuplicateUpsell(b.jobNumber, b.invoiceNumber, b.creditedTechnicianId);
    if (dupeUpsell) {
      return res.status(400).json({
        error: `${b.creditedTechnicianId == dupeUpsell.credited_technician_id ? 'This technician' : 'A technician'} already has an Upsell logged for invoice ${b.invoiceNumber} on Job Number ${b.jobNumber}.`,
      });
    }

    const saleValues = {
      job_number: b.jobNumber || '',
      credited_technician_id: b.creditedTechnicianId || null,
      // The original job's Trade, Job Type and Suburb are auto-populated
      // below where possible, but stay editable — an explicit value in the
      // request always wins over the matched job's own value, and none of
      // this ever touches the original job row itself.
      trade_id: b.tradeId || matchedJob.trade_id || null,
      job_type_id: b.jobTypeId || matchedJob.job_type_id || null,
      invoice_number: b.invoiceNumber || '',
      // The matched invoice's own date is the sensible default for "relevant
      // invoice date" — still editable in case it needs correcting.
      invoice_date: b.invoiceDate || matchedSale.invoice_date || '',
      // The ADDITIONAL upsell value ex GST only — never the full invoice
      // value again (the original sale's own sale_value_ex_gst is never
      // read or added here).
      sale_value_ex_gst: Number(b.saleValueExGst) || 0,
      comments: b.comments || '',
      suburb: b.suburb || matchedJob.suburb || '',
    };
    const saleId = transaction(() => {
      const { lastInsertRowid } = run(
        `INSERT INTO sales (job_id, job_number, source, is_upsell, date_logged, credited_technician_id, trade_id, job_type_id,
          invoice_number, invoice_date, sale_value_ex_gst, comments, suburb, created_by_user_id)
         VALUES (?, ?, 'quote_approved_later', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          matchedJob.id,
          saleValues.job_number,
          b.dateLogged,
          saleValues.credited_technician_id,
          saleValues.trade_id,
          saleValues.job_type_id,
          saleValues.invoice_number,
          saleValues.invoice_date,
          saleValues.sale_value_ex_gst,
          saleValues.comments,
          saleValues.suburb,
          req.user.id,
        ]
      );
      recordAudit({ entityType: 'sale', entityId: lastInsertRowid, before: null, after: saleValues, fields: SALE_TRACKED_FIELDS, userId: req.user.id });
      // Deliberately never calls findConvertibleKnockback/flips converted_later
      // here — an Upsell must never count as Converted Later or touch the
      // original job's own knock-back/conversion state in any way.
      return lastInsertRowid;
    });

    res.status(201).json({ entry: saleToEntry(saleRow(saleId)) });
  });

  router.patch('/existing-job-upsell/:id', (req, res) => {
    const existing = get('SELECT * FROM sales WHERE id = ? AND is_upsell = 1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    // Re-checked on edit only when the job/invoice/technician combination is
    // actually changing — the same "must match an existing invoice" /
    // "no duplicate" rules as creation, exactly mirroring how Quote Approved
    // Later's own edit route re-checks its duplicate New Job Number rule
    // above only when that field is actually being changed.
    const nextJobNumber = b.jobNumber ?? existing.job_number;
    const nextInvoiceNumber = b.invoiceNumber ?? existing.invoice_number;
    const nextCreditedTechnicianId = mergeId(b.creditedTechnicianId, existing.credited_technician_id) || originalJobTechnicianId(existing.job_id);
    if (b.jobNumber !== undefined || b.invoiceNumber !== undefined) {
      const matchedSale = findSaleForInvoice(nextJobNumber, nextInvoiceNumber);
      if (!matchedSale) {
        return res.status(400).json({
          error: `No existing invoice ${nextInvoiceNumber} found for Job Number ${nextJobNumber}. "Existing Job — Upsell" must reference an invoice that's already on record for that job.`,
        });
      }
    }
    if (b.jobNumber !== undefined || b.invoiceNumber !== undefined || b.creditedTechnicianId !== undefined) {
      const dupeUpsell = findDuplicateUpsell(nextJobNumber, nextInvoiceNumber, nextCreditedTechnicianId, req.params.id);
      if (dupeUpsell) {
        return res.status(400).json({
          error: `${nextCreditedTechnicianId == dupeUpsell.credited_technician_id ? 'This technician' : 'A technician'} already has an Upsell logged for invoice ${nextInvoiceNumber} on Job Number ${nextJobNumber}.`,
        });
      }
    }
    const next = {
      job_number: nextJobNumber,
      // Same fallback as Quote Approved Later's own edit route — an edit
      // that clears Credited Technician falls back to the original job's
      // technician, never silently saving null.
      credited_technician_id: nextCreditedTechnicianId,
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      invoice_number: nextInvoiceNumber,
      invoice_date: b.invoiceDate ?? existing.invoice_date,
      sale_value_ex_gst: b.saleValueExGst !== undefined ? Number(b.saleValueExGst) || 0 : existing.sale_value_ex_gst,
      comments: b.comments ?? existing.comments,
      suburb: b.suburb ?? existing.suburb,
    };
    const dateLogged = b.dateLogged ?? existing.date_logged;
    run(
      `UPDATE sales SET job_number=?, date_logged=?, credited_technician_id=?, trade_id=?, job_type_id=?, invoice_number=?, invoice_date=?,
        sale_value_ex_gst=?, comments=?, suburb=?, updated_at=datetime('now') WHERE id=?`,
      [
        next.job_number,
        dateLogged,
        next.credited_technician_id,
        next.trade_id,
        next.job_type_id,
        next.invoice_number,
        next.invoice_date,
        next.sale_value_ex_gst,
        next.comments,
        next.suburb,
        req.params.id,
      ]
    );
    recordAudit({ entityType: 'sale', entityId: Number(req.params.id), before: existing, after: next, fields: SALE_TRACKED_FIELDS, userId: req.user.id });
    res.json(saleToEntry(saleRow(req.params.id)));
  });

  // ---- Call Back ----
  router.post('/call-backs', (req, res) => {
    const b = req.body || {};
    if (!b.jobNumber || !String(b.jobNumber).trim()) {
      return res.status(400).json({ error: 'Please enter the Original Job Number before saving.' });
    }
    // Attending Technician and Credited Technician are both mandatory on
    // creation (never on edit, so a legacy entry saved before this check
    // existed can still be edited) — Credited Technician in particular is
    // what every Technician & Sales report figure counts this entry
    // towards, and leaving it blank is exactly how a call back could
    // silently fall into an "Unassigned" bucket in reports.
    const missing = [];
    if (!b.technicianId) missing.push('Attending Technician');
    if (!b.creditedTechnicianId) missing.push('Credited Technician');
    if (missing.length) {
      return res.status(400).json({
        error: `Please complete the following required field${missing.length > 1 ? 's' : ''} before saving: ${missing.join(', ')}.`,
      });
    }
    if (!isTechnicianActive(b.technicianId)) {
      return res.status(400).json({ error: 'This technician has been deactivated and cannot be assigned to a new call back.' });
    }
    // The New Callback Job Number is optional even on creation (the callback
    // may be logged before it's actually booked), but once given, each one
    // must still be its own — scoped strictly to call_backs.new_job_number
    // (see findDuplicateCallBackJobNumber), so this can never be tripped by
    // the Original Job Number it's linked against.
    if (b.newJobNumber && String(b.newJobNumber).trim()) {
      const dupe = findDuplicateCallBackJobNumber(b.newJobNumber);
      if (dupe) {
        return res.status(400).json({
          error: `New Callback Job Number ${b.newJobNumber} is already used on another Call Back (Original JN ${dupe.job_number}). Each New Callback Job Number can only be used once.`,
        });
      }
    }
    const matchedJob = findOriginalJob(b.jobNumber);
    // The original job's Trade and Job Type are auto-populated below where
    // possible, but stay editable — an explicit value in the request always
    // wins over the matched job's own value. A Call Back is never blocked
    // for lack of a match, though — unlike Quote Approved Later/Upsell, it
    // isn't required to reference an existing job: it may be logged before
    // that job is even in the system yet (left simply unlinked, job_id NULL,
    // until it is).
    const values = {
      job_number: b.jobNumber || '',
      new_job_number: b.newJobNumber || '',
      attending_technician_id: b.technicianId || null,
      credited_technician_id: b.creditedTechnicianId || null,
      trade_id: b.tradeId || matchedJob?.trade_id || null,
      job_type_id: b.jobTypeId || matchedJob?.job_type_id || null,
      reason_id: b.reasonId || null,
      comments: b.comments || '',
    };
    const { lastInsertRowid } = run(
      `INSERT INTO call_backs (job_id, job_number, new_job_number, visit_date, attending_technician_id, credited_technician_id,
        trade_id, job_type_id, reason_id, comments, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        matchedJob?.id || null,
        values.job_number,
        values.new_job_number,
        b.visitDate,
        values.attending_technician_id,
        values.credited_technician_id,
        values.trade_id,
        values.job_type_id,
        values.reason_id,
        values.comments,
        req.user.id,
      ]
    );
    recordAudit({ entityType: 'call_back', entityId: lastInsertRowid, before: null, after: values, fields: CALL_BACK_TRACKED_FIELDS, userId: req.user.id });
    res.status(201).json({ entry: callBackToEntry(callBackRow(lastInsertRowid)) });
  });

  router.patch('/call-backs/:id', (req, res) => {
    const existing = get('SELECT * FROM call_backs WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    // Re-checked on edit only when the New Callback Job Number is actually
    // changing — never blocked re-saving a record with its own unchanged
    // value — exactly mirroring Quote Approved Later's own New Job Number
    // edit-time check.
    if (b.newJobNumber !== undefined && String(b.newJobNumber).trim()) {
      const dupe = findDuplicateCallBackJobNumber(b.newJobNumber, req.params.id);
      if (dupe) {
        return res.status(400).json({
          error: `New Callback Job Number ${b.newJobNumber} is already used on another Call Back (Original JN ${dupe.job_number}). Each New Callback Job Number can only be used once.`,
        });
      }
    }
    const attending_technician_id = mergeId(b.technicianId, existing.attending_technician_id);
    const next = {
      job_number: b.jobNumber ?? existing.job_number,
      new_job_number: b.newJobNumber ?? existing.new_job_number,
      attending_technician_id,
      // Same fallback as Quote Approved Later's own edit route — an edit
      // that clears Credited Technician falls back to whoever actually
      // completed the linked original job's work (its own attending
      // technician, or its separate Install Technician when that job says
      // the work was completed on a different day — see
      // originalWorkTechnicianId()), then this same call back's own
      // Attending Technician, which is always present. job_id can
      // legitimately be null, since a Call Back is never required to match
      // an existing job. Never applied when an explicit value is given.
      credited_technician_id:
        mergeId(b.creditedTechnicianId, existing.credited_technician_id) ||
        originalWorkTechnicianId(existing.job_id) ||
        attending_technician_id,
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      reason_id: mergeId(b.reasonId, existing.reason_id),
      comments: b.comments ?? existing.comments,
    };
    const visitDate = b.visitDate ?? existing.visit_date;
    run(
      `UPDATE call_backs SET job_number=?, new_job_number=?, visit_date=?, attending_technician_id=?, credited_technician_id=?,
        trade_id=?, job_type_id=?, reason_id=?, comments=?, updated_at=datetime('now') WHERE id=?`,
      [
        next.job_number,
        next.new_job_number,
        visitDate,
        next.attending_technician_id,
        next.credited_technician_id,
        next.trade_id,
        next.job_type_id,
        next.reason_id,
        next.comments,
        req.params.id,
      ]
    );
    recordAudit({ entityType: 'call_back', entityId: Number(req.params.id), before: existing, after: next, fields: CALL_BACK_TRACKED_FIELDS, userId: req.user.id });
    res.json(callBackToEntry(callBackRow(req.params.id)));
  });

  // ---- Pending Cancellation ----
  router.post('/pending-cancellations', (req, res) => {
    const b = req.body || {};
    if (!b.jobNumber || !String(b.jobNumber).trim()) {
      return res.status(400).json({ error: 'Please enter a Job Number before saving.' });
    }
    const matchedSale = findLatestSale(b.jobNumber);
    const values = {
      job_number: b.jobNumber || '',
      // No explicit value and no matched sale's own credited technician ->
      // fall back to the original job's technician (via the matched sale's
      // job_id), the same backstop used for Quote Approved Later/Call Back —
      // see syncPendingCancellation() in routes/calls.js for the same rule
      // applied to how this entry type is actually created in the UI today.
      credited_technician_id: b.creditedTechnicianId || matchedSale?.credited_technician_id || originalJobTechnicianId(matchedSale?.job_id) || null,
      reason_id: b.reasonId || null,
      comments: b.comments || '',
    };
    const { lastInsertRowid } = run(
      `INSERT INTO pending_cancellations (sale_id, job_number, date_logged, credited_technician_id, trade_id,
        reason_id, comments, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        matchedSale?.id || null,
        values.job_number,
        b.dateLogged,
        values.credited_technician_id,
        matchedSale?.trade_id || null,
        values.reason_id,
        values.comments,
        req.user.id,
      ]
    );
    recordAudit({ entityType: 'pending_cancellation', entityId: lastInsertRowid, before: null, after: values, fields: PENDING_CANCELLATION_TRACKED_FIELDS, userId: req.user.id });
    res.status(201).json({ entry: pendingCancellationToEntry(pendingCancellationRow(lastInsertRowid)) });
  });

  router.patch('/pending-cancellations/:id', (req, res) => {
    const existing = get('SELECT * FROM pending_cancellations WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    const next = {
      job_number: b.jobNumber ?? existing.job_number,
      // Same fallback as Quote Approved Later/Call Back's own edit routes —
      // an edit that clears Credited Technician falls back to the original
      // job's technician (via this entry's linked sale's job_id), rather
      // than silently saving null.
      credited_technician_id:
        mergeId(b.creditedTechnicianId, existing.credited_technician_id) ||
        originalJobTechnicianId(existing.sale_id ? get('SELECT job_id FROM sales WHERE id = ?', [existing.sale_id])?.job_id : null),
      reason_id: mergeId(b.reasonId, existing.reason_id),
      comments: b.comments ?? existing.comments,
    };
    const dateLogged = b.dateLogged ?? existing.date_logged;
    run(
      `UPDATE pending_cancellations SET job_number=?, date_logged=?, credited_technician_id=?, reason_id=?,
        comments=?, updated_at=datetime('now') WHERE id=?`,
      [next.job_number, dateLogged, next.credited_technician_id, next.reason_id, next.comments, req.params.id]
    );
    recordAudit({ entityType: 'pending_cancellation', entityId: Number(req.params.id), before: existing, after: next, fields: PENDING_CANCELLATION_TRACKED_FIELDS, userId: req.user.id });
    res.json(pendingCancellationToEntry(pendingCancellationRow(req.params.id)));
  });

  // ---- Archive / delete (generic across the four underlying tables) ----
  const TABLE_BY_KIND = {
    new_job_no_sale: 'jobs',
    new_job_sale_made: 'jobs',
    quote_approved_later: 'sales',
    existing_job_upsell: 'sales',
    call_back: 'call_backs',
    pending_cancellation: 'pending_cancellations',
  };

  router.patch('/entries/:kind/:id/archive', (req, res) => {
    const table = TABLE_BY_KIND[req.params.kind];
    if (!table) return res.status(404).json({ error: 'Unknown entry kind.' });
    run(`UPDATE ${table} SET archived = ? WHERE id = ?`, [req.body?.archived ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  });

  router.delete('/entries/:kind/:id', (req, res) => {
    const table = TABLE_BY_KIND[req.params.kind];
    if (!table) return res.status(404).json({ error: 'Unknown entry kind.' });
    try {
      run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      // A job/sale that's still linked to another record (a job's own sale,
      // or the sale that converted a knock-back) can't be deleted without
      // also deleting or unlinking that other record — which Delete here has
      // never done, so this always failed. listTechEntries() now computes
      // canDelete so the UI never offers Delete on these; this catch is the
      // backend backstop for a direct API call bypassing that, or any entry
      // whose links changed between page load and this click — either way it
      // must never delete the linked record itself, just refuse cleanly.
      if (String(err.message).includes('FOREIGN KEY constraint failed')) {
        return res.status(409).json({ error: 'This entry has linked sales or job information and cannot be permanently deleted. Please archive it instead.' });
      }
      throw err;
    }
  });

  return router;
}
