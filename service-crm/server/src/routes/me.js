import { Router } from 'express';
import { all } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { computeTechReport, computeKnockbackReasonsReport, drilldownTech } from '../services/reports.js';
import { listTechEntries } from './techSales.js';
import { listReviews } from './reviews.js';
import { classifyRating } from '../lib/reviewRating.js';

// Technician accounts only, all read-only, no exports, no writes:
// - the team Technician & Sales report (/team-report, /team-knockback-
//   reasons, /report-settings): the same statistics Staff see, but only as
//   whitelisted aggregate fields — never records, job numbers, customer
//   details or audit fields, and no record-level drill-down for the team or
//   other technicians;
// - their OWN records behind their own By technician figures
//   (/performance/drilldown), always for the technician linked to the
//   signed-in account (req.user.technicianId from technician_accounts),
//   never one taken from the request;
// - My Reviews (/reviews).

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj && f in obj).map((f) => [f, obj[f]]));
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const id = (v) => (v !== undefined && /^\d+$/.test(String(v)) ? String(v) : undefined);
const oneOf = (v, options) => (options.includes(v) ? v : undefined);
const ENTRY_TYPES = ['new_job_no_sale', 'new_job_sale_made', 'quote_approved_later', 'existing_job_upsell', 'call_back', 'pending_cancellation'];

// The normal Technician & Sales report filters a technician may use. Left
// out on purpose: Job Number, Suburb, Created By and Last Edited By — each
// can narrow the statistics down to one identifiable job or staff member.
function teamFilters(q) {
  return {
    from: date(q.from),
    to: date(q.to),
    technicianId: id(q.technicianId),
    tradeId: id(q.tradeId),
    jobTypeId: id(q.jobTypeId),
    leadQualification: oneOf(q.leadQualification, ['Qualified', 'Not Qualified', 'unassigned']),
    leadSourceId: q.leadSourceId === 'unassigned' ? 'unassigned' : id(q.leadSourceId),
    saleMade: oneOf(q.saleMade, ['Yes', 'No']),
    knockback: oneOf(q.knockback, ['Yes', 'No']),
    convertedLater: oneOf(q.convertedLater, ['Yes', 'No']),
    entryType: oneOf(q.entryType, ENTRY_TYPES),
  };
}

// The same filters for the technician's own records — with the technician
// always forced to their own, whatever was sent.
function ownFilters(q, user) {
  return { ...teamFilters(q), technicianId: String(user.technicianId) };
}

// Aggregate fields only, everything else in the report response is dropped.
const METRIC_FIELDS = [
  'jobsAttended', 'qualifiedJobs', 'unqualifiedJobs', 'knockbacks', 'knockbackRate', 'convertedLaterCount', 'conversionRate', 'sales',
  'totalSaleExGst', 'avgSaleExGst', 'upsellsCount', 'upsellValueExGst', 'callBacks', 'pendingCancellations', 'inspectionRate',
  'optionRate', 'actualKnockbacks', 'convertedLaterCredits', 'adjustedKnockbacks', 'bonusConversionRate',
];
const MARKETING_FIELDS = ['category', 'attendedQualified', 'saleMade', 'convertedLater', 'sales', 'knockbacks', 'conversionPct', 'totalSalesValueExGst', 'averageSaleValue'];
const pickAll = (list, fields) => (list || []).map((x) => pick(x, fields));

function teamReportView(report) {
  return {
    company: pick(report.company, METRIC_FIELDS),
    byTrade: pickAll(report.byTrade, ['trade', ...METRIC_FIELDS]),
    byTechnician: pickAll(report.byTechnician, ['name', ...METRIC_FIELDS, 'positiveReviewsCount']),
    salesByTradePie: pickAll(report.salesByTradePie, ['name', 'value']),
    jobsOppSalesByTrade: pickAll(report.jobsOppSalesByTrade, ['name', 'Jobs', 'Qualified leads', 'Sales']),
    trend: pickAll(report.trend, ['period', 'value', 'count']),
    missingTechnicianCount: report.missingTechnicianCount,
    includedPopulations: report.includedPopulations,
    revenueBySuburb: pickAll(report.revenueBySuburb, ['suburb', 'totalSalesValueExGst', 'salesCount', 'averageSaleValue']),
    salesByMarketingCategory: {
      rows: pickAll(report.salesByMarketingCategory.rows, MARKETING_FIELDS),
      totals: pick(report.salesByMarketingCategory.totals, MARKETING_FIELDS),
    },
  };
}

// The technician's own figures that open records — the same ones that are
// clickable in the admin By technician row (Adjusted Knockbacks and
// Conversion % are calculated, not record groups).
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
]);

// What a technician sees of one of their own records: the job/sale details,
// including sale values, but never comments or suburb (they can hold
// customer details), who created/edited it, its history, archive/delete
// state or internal ids of other people.
const RECORD_FIELDS = [
  'kind', 'id', 'entryLabel', 'dateShown', 'visitDate', 'jobNumber', 'newJobNumber', 'technicianName', 'creditedTechnicianName',
  'tradeName', 'jobTypeName', 'lead', 'knockback', 'knockbackReasonName', 'convertedLater', 'inspectionSheet',
  'optionSheet', 'workCompletion', 'installDate', 'installTechnicianName', 'invoiceNumber', 'invoiceDate', 'saleValueExGst',
  'reasonName',
];

export function createMeRouter() {
  const router = Router();
  router.use(requireAuth, (req, res, next) => {
    if (req.user.role !== 'technician') return res.status(403).json({ error: 'Only Technician accounts use these pages.' });
    if (!req.user.technicianActive) {
      return res.status(403).json({ error: 'Your technician record is inactive or missing — please contact an admin.', inactiveTechnician: true });
    }
    next();
  });

  // What the report's filter dropdowns need — names only, no accounts.
  router.get('/report-settings', (req, res) => {
    const trades = all('SELECT id, name FROM trades ORDER BY sort_order').map((t) => ({
      ...t,
      jobTypes: all('SELECT id, name FROM job_types WHERE trade_id = ? ORDER BY sort_order', [t.id]),
    }));
    const technicians = all('SELECT id, name, active FROM technicians ORDER BY sort_order').map((t) => ({ ...t, active: !!t.active }));
    const list = (category) => all('SELECT id, name FROM list_items WHERE category = ? ORDER BY sort_order', [category]);
    res.json({
      trades,
      technicians,
      lists: { lead_source: list('lead_source'), knockback_reason: list('knockback_reason') },
      ownTechnicianId: req.user.technicianId,
      ownTechnicianName: req.user.technicianName,
    });
  });

  // The team Technician & Sales report — statistics only (teamReportView).
  router.get('/team-report', (req, res) => {
    const granularity = oneOf(req.query.granularity, ['day', 'week', 'month']) || 'week';
    res.json(teamReportView(computeTechReport({ ...teamFilters(req.query), granularity })));
  });

  // Team Knockback Reasons — counts per reason only, never the job records.
  router.get('/team-knockback-reasons', (req, res) => {
    const f = teamFilters(req.query);
    const { total, byReason } = computeKnockbackReasonsReport({
      from: f.from,
      to: f.to,
      technicianId: f.technicianId,
      tradeId: f.tradeId,
      reasonId: id(req.query.reasonId),
    });
    res.json({ total, byReason });
  });

  router.get('/performance/drilldown', (req, res) => {
    const field = String(req.query.field || '');
    if (!DRILLDOWN_FIELDS.has(field)) return res.status(400).json({ error: "This figure can't be opened." });
    const params = ownFilters(req.query, req.user);
    const result = drilldownTech({ ...params, metric: field, scopeTechnician: req.user.technicianName });
    if (!result) return res.status(400).json({ error: "This figure can't be opened." });
    const keySet = new Set(result.rows.map((r) => `${r.kind}:${r.id}`));
    const rows = listTechEntries({ includeArchived: 'true' })
      .filter((e) => keySet.has(`${e.kind}:${e.id}`))
      .map((e) => pick(e, RECORD_FIELDS));
    res.json({ label: result.label, count: rows.length, outcomes: result.outcomes || null, rows });
  });

  // Reviews credited to this technician only — a review shared with other
  // technicians counts here too, but their names are never shown.
  router.get('/reviews', (req, res) => {
    const rows = listReviews({ from: date(req.query.from), to: date(req.query.to), technicianId: req.user.technicianId }).map((r) => ({
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
