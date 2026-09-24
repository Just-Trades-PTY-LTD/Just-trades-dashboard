import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, getHistory, getHistoryCounts } from '../lib/audit.js';
import { mergeId } from '../lib/merge.js';
import { findConvertibleKnockback, findDuplicateInvoice, findOriginalJob, findLatestSale, normKey } from '../services/lookup.js';
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
];
const SALE_TRACKED_FIELDS = [
  'job_number',
  'credited_technician_id',
  'trade_id',
  'job_type_id',
  'invoice_number',
  'invoice_date',
  'sale_value_ex_gst',
  'comments',
];
const CALL_BACK_TRACKED_FIELDS = [
  'job_number',
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
      tr.name AS trade_name, jt.name AS job_type_name, kr.name AS knockback_reason_name
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN technicians it ON it.id = j.install_technician_id
     LEFT JOIN trades tr ON tr.id = j.trade_id
     LEFT JOIN job_types jt ON jt.id = j.job_type_id
     LEFT JOIN list_items kr ON kr.id = j.knockback_reason_id
     WHERE j.id = ?`,
    [id]
  );
}

function saleRow(id) {
  return get(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     LEFT JOIN job_types jt ON jt.id = s.job_type_id
     WHERE s.id = ?`,
    [id]
  );
}

function callBackRow(id) {
  return get(
    `SELECT cb.*, at.name AS attending_technician_name, ct.name AS credited_technician_name,
      tr.name AS trade_name, jt.name AS job_type_name, r.name AS reason_name
     FROM call_backs cb
     LEFT JOIN technicians at ON at.id = cb.attending_technician_id
     LEFT JOIN technicians ct ON ct.id = cb.credited_technician_id
     LEFT JOIN trades tr ON tr.id = cb.trade_id
     LEFT JOIN job_types jt ON jt.id = cb.job_type_id
     LEFT JOIN list_items r ON r.id = cb.reason_id
     WHERE cb.id = ?`,
    [id]
  );
}

function pendingCancellationRow(id) {
  return get(
    `SELECT pc.*, t.name AS credited_technician_name, tr.name AS trade_name, r.name AS reason_name
     FROM pending_cancellations pc
     LEFT JOIN technicians t ON t.id = pc.credited_technician_id
     LEFT JOIN trades tr ON tr.id = pc.trade_id
     LEFT JOIN list_items r ON r.id = pc.reason_id
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
    createdAt: j.created_at,
  };
}

function saleToEntry(s) {
  return {
    kind: 'quote_approved_later',
    entryLabel: 'Existing Job — Quote Approved Later',
    id: s.id,
    archived: !!s.archived,
    dateShown: s.date_logged,
    technicianId: s.credited_technician_id,
    technicianName: s.credited_technician_name,
    creditedTechnicianId: s.credited_technician_id,
    creditedTechnicianName: s.credited_technician_name,
    jobNumber: s.job_number,
    tradeId: s.trade_id,
    tradeName: s.trade_name,
    jobTypeId: s.job_type_id,
    jobTypeName: s.job_type_name,
    invoiceNumber: s.invoice_number,
    invoiceDate: s.invoice_date,
    saleValueExGst: s.sale_value_ex_gst,
    comments: s.comments,
    createdAt: s.created_at,
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
    jobNumber: cb.job_number,
    tradeId: cb.trade_id,
    tradeName: cb.trade_name,
    jobTypeId: cb.job_type_id,
    jobTypeName: cb.job_type_name,
    reasonId: cb.reason_id,
    reasonName: cb.reason_name,
    comments: cb.comments,
    createdAt: cb.created_at,
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
    jobNumber: pc.job_number,
    tradeId: pc.trade_id,
    tradeName: pc.trade_name,
    reasonId: pc.reason_id,
    reasonName: pc.reason_name,
    comments: pc.comments,
    createdAt: pc.created_at,
  };
}

const ENTITY_TYPE_BY_KIND = {
  new_job_no_sale: 'job',
  new_job_sale_made: 'job',
  quote_approved_later: 'sale',
  call_back: 'call_back',
  pending_cancellation: 'pending_cancellation',
};

export function listTechEntries({ from, to, technicianId, tradeId, entryType, jobNumber, includeArchived } = {}) {
  const showArchived = includeArchived === 'true';

    let entries = [
      ...all(`SELECT j.*, t.name AS technician_name, it.name AS install_technician_name, tr.name AS trade_name,
                jt.name AS job_type_name, kr.name AS knockback_reason_name
              FROM jobs j
              LEFT JOIN technicians t ON t.id = j.technician_id
              LEFT JOIN technicians it ON it.id = j.install_technician_id
              LEFT JOIN trades tr ON tr.id = j.trade_id
              LEFT JOIN job_types jt ON jt.id = j.job_type_id
              LEFT JOIN list_items kr ON kr.id = j.knockback_reason_id`).map(jobToEntry),
      ...all(`SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name, jt.name AS job_type_name
              FROM sales s
              LEFT JOIN technicians t ON t.id = s.credited_technician_id
              LEFT JOIN trades tr ON tr.id = s.trade_id
              LEFT JOIN job_types jt ON jt.id = s.job_type_id
              WHERE s.source = 'quote_approved_later'`).map(saleToEntry),
      ...all(`SELECT cb.*, at.name AS attending_technician_name, ct.name AS credited_technician_name,
                tr.name AS trade_name, jt.name AS job_type_name, r.name AS reason_name
              FROM call_backs cb
              LEFT JOIN technicians at ON at.id = cb.attending_technician_id
              LEFT JOIN technicians ct ON ct.id = cb.credited_technician_id
              LEFT JOIN trades tr ON tr.id = cb.trade_id
              LEFT JOIN job_types jt ON jt.id = cb.job_type_id
              LEFT JOIN list_items r ON r.id = cb.reason_id`).map(callBackToEntry),
      ...all(`SELECT pc.*, t.name AS credited_technician_name, tr.name AS trade_name, r.name AS reason_name
              FROM pending_cancellations pc
              LEFT JOIN technicians t ON t.id = pc.credited_technician_id
              LEFT JOIN trades tr ON tr.id = pc.trade_id
              LEFT JOIN list_items r ON r.id = pc.reason_id`).map(pendingCancellationToEntry),
    ];

    if (!showArchived) entries = entries.filter((e) => !e.archived);
    if (from) entries = entries.filter((e) => (e.dateShown || '') >= from);
    if (to) entries = entries.filter((e) => (e.dateShown || '') <= to);
    if (technicianId) {
      const tid = Number(technicianId);
      entries = entries.filter((e) => e.technicianId === tid || e.creditedTechnicianId === tid);
    }
    if (tradeId) entries = entries.filter((e) => e.tradeId === Number(tradeId));
    if (entryType) entries = entries.filter((e) => e.kind === entryType);
    if (jobNumber) entries = entries.filter((e) => normKey(e.jobNumber) === normKey(jobNumber));

  entries.sort((a, b) => (b.dateShown || '').localeCompare(a.dateShown || '') || b.id - a.id);

  const idsByType = {};
  entries.forEach((e) => {
    const t = ENTITY_TYPE_BY_KIND[e.kind];
    (idsByType[t] ||= []).push(e.id);
  });
  const countsByType = {};
  Object.entries(idsByType).forEach(([t, ids]) => {
    countsByType[t] = getHistoryCounts(t, ids);
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
    e.relatedCallsCount = e.jobNumber
      ? get('SELECT COUNT(*) AS n FROM calls WHERE archived = 0 AND lower(trim(job_number)) = ?', [normKey(e.jobNumber)]).n
      : 0;
    if (e.kind === 'quote_approved_later') e.canDelete = !saleIdsConvertedFrom.has(e.id);
    else if (e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made') e.canDelete = !jobIdsWithSales.has(e.id);
    else e.canDelete = true;
  });

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
    };
    const wb = buildJobHistoryWorkbook(rows, req.query, lookups);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="technician-sales-history-${new Date().toISOString().slice(0, 10)}.xlsx"`);
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
      };
      const { lastInsertRowid: jobId } = run(
        `INSERT INTO jobs (job_number, visit_date, technician_id, trade_id, job_type_id, lead, inspection_sheet,
          option_sheet, had_sale_at_visit, knockback, knockback_reason_id, work_completion, install_technician_id,
          install_date, comments, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    };
    const visitDate = b.visitDate ?? existing.visit_date;

    transaction(() => {
      run(
        `UPDATE jobs SET technician_id=?, job_number=?, visit_date=?, trade_id=?, job_type_id=?, lead=?,
          inspection_sheet=?, option_sheet=?, knockback_reason_id=?, work_completion=?, install_technician_id=?,
          install_date=?, comments=?, updated_at=datetime('now') WHERE id=?`,
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
    if (!b.jobNumber || !String(b.jobNumber).trim()) {
      return res.status(400).json({ error: 'Please enter a Job Number before saving.' });
    }
    // "Existing Job — Quote Approved Later" only ever makes sense against a
    // job that's actually on record — it must match by exact Job Number
    // (never a partial/fuzzy match, so it can never link to the wrong job),
    // and is blocked entirely rather than saved half-linked if nothing
    // matches.
    const matchedJob = findOriginalJob(b.jobNumber);
    if (!matchedJob) {
      return res.status(400).json({
        error: `No existing job found for JN ${b.jobNumber}. "Existing Job — Quote Approved Later" must reference a Job Number that was already logged as a New Job entry.`,
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
      // request always wins over the matched job's own value.
      const saleValues = {
        job_number: b.jobNumber || '',
        credited_technician_id: b.creditedTechnicianId || null,
        trade_id: b.tradeId || matchedJob.trade_id || null,
        job_type_id: b.jobTypeId || matchedJob.job_type_id || null,
        invoice_number: b.invoiceNumber || '',
        invoice_date: b.invoiceDate || '',
        sale_value_ex_gst: Number(b.saleValueExGst) || 0,
        comments: b.comments || '',
      };
      const { lastInsertRowid } = run(
        `INSERT INTO sales (job_id, job_number, source, date_logged, credited_technician_id, trade_id, job_type_id,
          invoice_number, invoice_date, sale_value_ex_gst, comments, created_by_user_id)
         VALUES (?, ?, 'quote_approved_later', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const existing = get('SELECT * FROM sales WHERE id = ? AND source = ?', [req.params.id, 'quote_approved_later']);
    if (!existing) return res.status(404).json({ error: 'Entry not found.' });
    const b = req.body || {};
    const next = {
      job_number: b.jobNumber ?? existing.job_number,
      credited_technician_id: mergeId(b.creditedTechnicianId, existing.credited_technician_id),
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      invoice_number: b.invoiceNumber ?? existing.invoice_number,
      invoice_date: b.invoiceDate ?? existing.invoice_date,
      sale_value_ex_gst: b.saleValueExGst !== undefined ? Number(b.saleValueExGst) || 0 : existing.sale_value_ex_gst,
      comments: b.comments ?? existing.comments,
    };
    const dateLogged = b.dateLogged ?? existing.date_logged;
    run(
      `UPDATE sales SET job_number=?, date_logged=?, credited_technician_id=?, trade_id=?, job_type_id=?, invoice_number=?, invoice_date=?,
        sale_value_ex_gst=?, comments=?, updated_at=datetime('now') WHERE id=?`,
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
      return res.status(400).json({ error: 'Please enter a Job Number before saving.' });
    }
    const matchedJob = findOriginalJob(b.jobNumber);
    // The original job's Trade and Job Type are auto-populated below where
    // possible, but stay editable — an explicit value in the request always
    // wins over the matched job's own value. A Call Back is never blocked
    // for lack of a match, though — it isn't required to reference an
    // existing job the way Quote Approved Later is.
    const values = {
      job_number: b.jobNumber || '',
      attending_technician_id: b.technicianId || null,
      credited_technician_id: b.creditedTechnicianId || null,
      trade_id: b.tradeId || matchedJob?.trade_id || null,
      job_type_id: b.jobTypeId || matchedJob?.job_type_id || null,
      reason_id: b.reasonId || null,
      comments: b.comments || '',
    };
    const { lastInsertRowid } = run(
      `INSERT INTO call_backs (job_id, job_number, visit_date, attending_technician_id, credited_technician_id,
        trade_id, job_type_id, reason_id, comments, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        matchedJob?.id || null,
        values.job_number,
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
    const next = {
      job_number: b.jobNumber ?? existing.job_number,
      attending_technician_id: mergeId(b.technicianId, existing.attending_technician_id),
      credited_technician_id: mergeId(b.creditedTechnicianId, existing.credited_technician_id),
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      reason_id: mergeId(b.reasonId, existing.reason_id),
      comments: b.comments ?? existing.comments,
    };
    const visitDate = b.visitDate ?? existing.visit_date;
    run(
      `UPDATE call_backs SET job_number=?, visit_date=?, attending_technician_id=?, credited_technician_id=?,
        trade_id=?, job_type_id=?, reason_id=?, comments=?, updated_at=datetime('now') WHERE id=?`,
      [
        next.job_number,
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
      credited_technician_id: b.creditedTechnicianId || null,
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
      credited_technician_id: mergeId(b.creditedTechnicianId, existing.credited_technician_id),
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
