import { Router } from 'express';
import { all } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { computeTechReport, computeKnockbackReasonsReport, computeReviewsReport, drilldownTech } from '../services/reports.js';
import { listTechEntries } from './techSales.js';
import { listReviews } from './reviews.js';
import { classifyRating } from '../lib/reviewRating.js';

// Technician accounts only, all read-only, no exports, no writes:
// - the team Technician & Sales report, limited to the approved sections —
//   Summary figures, Sale value by trade, By trade, By technician and
//   Knockback Reasons (/team-report, /team-knockback-reasons,
//   /report-settings) — as whitelisted aggregate fields only: never records,
//   job numbers, customer details, audit fields or any other report section;
// - their OWN records behind their own By technician figures and their own
//   knockback reasons (/performance/drilldown), always for the technician
//   linked to the signed-in account (req.user.technicianId from
//   technician_accounts), never one taken from the request;
// - the team's reviews, read-only (/reviews).

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj && f in obj).map((f) => [f, obj[f]]));
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const id = (v) => (v !== undefined && /^\d+$/.test(String(v)) ? String(v) : undefined);
const oneOf = (v, options) => (options.includes(v) ? v : undefined);

// The approved Technician & Sales report filters: dates (and so Quick
// range), Technician, Trade, Job Type and Lead Qualification. Everything
// else — Lead Source, the advanced filters, Job Number, Suburb, Created By,
// Last Edited By — is ignored.
function teamFilters(q) {
  return {
    from: date(q.from),
    to: date(q.to),
    technicianId: id(q.technicianId),
    tradeId: id(q.tradeId),
    jobTypeId: id(q.jobTypeId),
    leadQualification: oneOf(q.leadQualification, ['Qualified', 'Not Qualified', 'unassigned']),
  };
}

// The same filters for the technician's own records — with the technician
// always forced to their own, whatever was sent.
function ownFilters(q, user) {
  return { ...teamFilters(q), technicianId: String(user.technicianId) };
}

// Exactly the fields the approved sections show — everything else in the
// report (other sections, records) is dropped before it leaves the server.
// Summary figures and each By technician row show the same figures.
const SUMMARY_FIELDS = [
  'jobsAttended', 'qualifiedJobs', 'sales', 'convertedLaterCredits', 'actualKnockbacks', 'adjustedKnockbacks', 'bonusConversionRate',
  'totalSaleExGst', 'avgSaleExGst', 'upsellsCount', 'upsellValueExGst', 'unqualifiedJobs', 'callBacks', 'pendingCancellations',
  'inspectionRate', 'optionRate',
];
const BY_TRADE_FIELDS = [
  'trade', 'jobsAttended', 'totalSaleExGst', 'avgSaleExGst', 'knockbacks', 'convertedLaterCount', 'conversionRate', 'qualifiedJobs',
  'sales', 'upsellsCount', 'upsellValueExGst', 'callBacks', 'pendingCancellations', 'inspectionRate', 'optionRate',
];
const pickAll = (list, fields) => (list || []).map((x) => pick(x, fields));

function teamReportView(report) {
  return {
    company: pick(report.company, SUMMARY_FIELDS),
    salesByTradePie: pickAll(report.salesByTradePie, ['name', 'value']),
    byTrade: pickAll(report.byTrade, BY_TRADE_FIELDS),
    byTechnician: pickAll(report.byTechnician, ['name', ...SUMMARY_FIELDS, 'positiveReviewsCount']),
  };
}

// The technician's own figures that open records — the same ones that are
// clickable in the admin By technician row (Adjusted Knockbacks and
// Conversion % are calculated, not record groups) — and their own
// knockbacks for one reason (Knockback Reasons filtered to themselves).
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

  // The team Technician & Sales report — approved sections only (teamReportView).
  router.get('/team-report', (req, res) => {
    res.json(teamReportView(computeTechReport(teamFilters(req.query))));
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
    const result =
      field === 'knockbackByReason'
        ? drilldownTech({ from: params.from, to: params.to, technicianId: params.technicianId, tradeId: params.tradeId, metric: field, category: String(req.query.category || '') })
        : drilldownTech({ ...params, metric: field, scopeTechnician: req.user.technicianName });
    if (!result) return res.status(400).json({ error: "This figure can't be opened." });
    const keySet = new Set(result.rows.map((r) => `${r.kind}:${r.id}`));
    const rows = listTechEntries({ includeArchived: 'true' })
      .filter((e) => keySet.has(`${e.kind}:${e.id}`))
      .map((e) => pick(e, RECORD_FIELDS));
    res.json({ label: result.label, count: rows.length, outcomes: result.outcomes || null, rows });
  });

  // The team's reviews, read-only: every review, the technicians credited to
  // each (shared reviews name them all), team totals and the per-technician
  // breakdown. Never review link sent, Job Number, Created By / Edited By or
  // any history. Filters: dates, technician, star rating, classification.
  router.get('/reviews', (req, res) => {
    const filters = {
      from: date(req.query.from),
      to: date(req.query.to),
      technicianId: id(req.query.technicianId),
      rating: oneOf(String(req.query.rating ?? ''), ['1', '2', '3', '4', '5']),
      ratingClass: oneOf(req.query.ratingClass, ['Positive', 'Neutral', 'Negative']),
    };
    const rows = listReviews(filters).map((r) => ({
      id: r.id,
      reviewDate: r.reviewDate,
      rating: r.rating,
      classification: classifyRating(r.rating),
      notes: r.notes,
      technicians: (r.technicians || []).map((t) => t.name),
    }));
    const { kpis, byTechnician } = computeReviewsReport(filters);
    res.json({
      totals: {
        total: kpis.total,
        positive: kpis.positive,
        neutral: kpis.neutral,
        negative: kpis.negative,
        averageRating: kpis.total ? kpis.avgRating : null,
        byStars: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: rows.filter((r) => r.rating === stars).length })),
      },
      byTechnician: byTechnician.map((t) => ({ name: t.name, total: t.total, positive: t.positive })),
      rows,
    });
  });

  return router;
}
