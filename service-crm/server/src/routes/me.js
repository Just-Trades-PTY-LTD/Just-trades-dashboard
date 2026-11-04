import { Router } from 'express';
import { all } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { computeTechReport, computeKnockbackReasonsReport, drilldownTech } from '../services/reports.js';
import { listTechEntries } from './techSales.js';
import { listReviews } from './reviews.js';
import { classifyRating } from '../lib/reviewRating.js';

// Technician accounts only: read-only "My Performance", "My Knockback
// Reasons" and "My Reviews". Everything is scoped to the technician linked to
// the signed-in account (req.user.technicianId, set by middleware/auth.js
// from technician_accounts) — never to anything in the request. Only date,
// trade and job-type filters are read from the query string; every other
// parameter (technicianId, scopeTechnician, entry type, lead source, …) is
// ignored. No exports, no writes.

// The only filters a technician may use. Dates are YYYY-MM-DD; ids are numbers.
function allowedFilters(q) {
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const id = (v) => (v !== undefined && /^\d+$/.test(String(v)) ? String(v) : undefined);
  return { from: date(q.from), to: date(q.to), tradeId: id(q.tradeId), jobTypeId: id(q.jobTypeId) };
}

// Exactly the figures of this technician's own row in the admin "By
// technician" table (same computeTechReport() row, same definitions), with
// no company, trade or other-technician comparison.
const PERFORMANCE_FIELDS = [
  'jobsAttended',
  'qualifiedJobs',
  'sales',
  'convertedLaterCredits',
  'actualKnockbacks',
  'adjustedKnockbacks',
  'bonusConversionRate',
  'totalSaleExGst',
  'avgSaleExGst',
  'callBacks',
  'pendingCancellations',
  'inspectionRate',
  'optionRate',
];

// The figures that open records — the same ones that are clickable in the
// admin By technician row (Adjusted Knockbacks and Conversion % are
// calculated, not record groups), plus a knockback reason.
const DRILLDOWN_FIELDS = new Set([
  'jobsAttended',
  'qualifiedJobs',
  'sales',
  'convertedLaterCredits',
  'actualKnockbacks',
  'totalSaleExGst',
  'avgSaleExGst',
  'callBacks',
  'pendingCancellations',
  'inspectionRate',
  'optionRate',
  'knockbackByReason',
]);

// What a technician sees of one of their own records: the job/sale details,
// including sale values, but never who created/edited it, its history,
// archive/delete state or internal ids of other people.
const RECORD_FIELDS = [
  'kind', 'id', 'entryLabel', 'dateShown', 'visitDate', 'jobNumber', 'newJobNumber', 'technicianName', 'creditedTechnicianName',
  'tradeName', 'jobTypeName', 'suburb', 'lead', 'knockback', 'knockbackReasonName', 'convertedLater', 'inspectionSheet',
  'optionSheet', 'workCompletion', 'installDate', 'installTechnicianName', 'invoiceNumber', 'invoiceDate', 'saleValueExGst',
  'reasonName', 'comments',
];
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));

function emptyRow() {
  return Object.fromEntries(PERFORMANCE_FIELDS.map((f) => [f, f === 'inspectionRate' || f === 'optionRate' ? null : 0]));
}

export function createMeRouter() {
  const router = Router();
  router.use(requireAuth, (req, res, next) => {
    if (req.user.role !== 'technician') return res.status(403).json({ error: 'Only Technician accounts use these pages.' });
    if (!req.user.technicianActive) {
      return res.status(403).json({ error: 'Your technician record is inactive or missing — please contact an admin.', inactiveTechnician: true });
    }
    next();
  });

  // Trades and job types for the filter dropdowns (the full settings bundle
  // is not available to technicians).
  router.get('/filters', (req, res) => {
    const trades = all('SELECT id, name FROM trades ORDER BY sort_order').map((t) => ({
      ...t,
      jobTypes: all('SELECT id, name FROM job_types WHERE trade_id = ? ORDER BY sort_order', [t.id]),
    }));
    res.json({ trades, technicianName: req.user.technicianName });
  });

  router.get('/performance', (req, res) => {
    const f = allowedFilters(req.query);
    const report = computeTechReport({ ...f, technicianId: req.user.technicianId });
    const row = report.byTechnician.find((r) => r.name === req.user.technicianName);
    res.json({ technicianName: req.user.technicianName, filters: f, figures: row ? pick(row, PERFORMANCE_FIELDS) : emptyRow() });
  });

  router.get('/performance/drilldown', (req, res) => {
    const field = String(req.query.field || '');
    if (!DRILLDOWN_FIELDS.has(field)) return res.status(400).json({ error: "This figure can't be opened." });
    const f = allowedFilters(req.query);
    const params = { ...f, technicianId: req.user.technicianId };
    const result =
      field === 'knockbackByReason'
        ? drilldownTech({ ...params, metric: 'knockbackByReason', category: String(req.query.category || '') })
        : drilldownTech({ ...params, metric: field, scopeTechnician: req.user.technicianName });
    if (!result) return res.status(400).json({ error: "This figure can't be opened." });
    const keySet = new Set(result.rows.map((r) => `${r.kind}:${r.id}`));
    const rows = listTechEntries({ includeArchived: 'true' })
      .filter((e) => keySet.has(`${e.kind}:${e.id}`))
      .map((e) => pick(e, RECORD_FIELDS));
    res.json({ label: result.label, count: rows.length, outcomes: result.outcomes || null, rows });
  });

  router.get('/knockback-reasons', (req, res) => {
    const f = allowedFilters(req.query);
    const { total, byReason } = computeKnockbackReasonsReport({ ...f, technicianId: req.user.technicianId });
    res.json({ total, byReason });
  });

  // Reviews credited to this technician only — a review shared with other
  // technicians counts here too, but their names are never shown.
  router.get('/reviews', (req, res) => {
    const f = allowedFilters(req.query);
    const rows = listReviews({ from: f.from, to: f.to, technicianId: req.user.technicianId }).map((r) => ({
      id: r.id,
      reviewDate: r.reviewDate,
      rating: r.rating,
      classification: classifyRating(r.rating),
      notes: r.notes,
      shared: (r.technicians || []).length > 1,
    }));
    const count = (c) => rows.filter((r) => r.classification === c).length;
    const totals = {
      total: rows.length,
      positive: count('Positive'),
      neutral: count('Neutral'),
      negative: count('Negative'),
      averageRating: rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 100) / 100 : null,
      byStars: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: rows.filter((r) => r.rating === stars).length })),
    };
    res.json({ totals, rows });
  });

  return router;
}
