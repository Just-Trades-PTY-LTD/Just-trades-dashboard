import { Router } from 'express';
import { all, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { computeCallsReport, computeTechReport, drilldownCalls, drilldownTech } from '../services/reports.js';
import { buildCallsWorkbook, buildTechWorkbook } from '../lib/xlsxReports.js';
import { listCalls } from './calls.js';
import { listTechEntries } from './techSales.js';

function idNameMap(rows) {
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

async function sendWorkbook(res, workbook, filenamePrefix) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

// A user's saved Reports page layout (each section's size/collapsed state)
// is a pure display preference — scoped to req.user.id so one user's choices
// can never affect another's, and stored separately from every CRM record.
const REPORT_KEYS = ['calls', 'tech'];

export function createReportsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/calls', (req, res) => {
    res.json(computeCallsReport(req.query));
  });

  router.get('/tech', (req, res) => {
    res.json(computeTechReport(req.query));
  });

  // Drill-down: resolve one clickable figure/chart section on a report to
  // the exact records it represents. `metric` selects which figure; the rest
  // of the query string carries the report's own current filters (from/to/
  // handledByUserId, or from/to/technicianId/tradeId) plus whichever extra
  // selector that figure needs (category/segment/staffName, or category/
  // series/scopeTrade/scopeTechnician) — see services/reports.js for the
  // full list. Never creates, edits or reclassifies anything; read-only.
  router.get('/calls/drilldown', (req, res) => {
    const { metric } = req.query;
    if (!metric) return res.status(400).json({ error: 'A metric is required.' });
    const result = drilldownCalls(req.query);
    if (!result) return res.status(400).json({ error: `This figure can't be linked to specific records: "${metric}".` });
    const idSet = new Set(result.rows.map((r) => r.id));
    const rows = listCalls({ includeArchived: 'true' }).filter((r) => idSet.has(r.id));
    res.json({ label: result.label, count: rows.length, outcomes: result.outcomes || null, kind: 'calls', rows });
  });

  router.get('/tech/drilldown', (req, res) => {
    const { metric } = req.query;
    if (!metric) return res.status(400).json({ error: 'A metric is required.' });
    const result = drilldownTech(req.query);
    if (!result) return res.status(400).json({ error: `This figure can't be linked to specific records: "${metric}".` });
    const keySet = new Set(result.rows.map((r) => `${r.kind}:${r.id}`));
    const rows = listTechEntries({ includeArchived: 'true' }).filter((e) => keySet.has(`${e.kind}:${e.id}`));
    res.json({ label: result.label, count: rows.length, outcomes: result.outcomes || null, kind: 'tech', rows });
  });

  router.get('/layouts', (req, res) => {
    const rows = all('SELECT report_key, layout_json FROM user_report_layouts WHERE user_id = ?', [req.user.id]);
    const out = {};
    rows.forEach((r) => {
      try {
        out[r.report_key] = JSON.parse(r.layout_json);
      } catch {
        out[r.report_key] = {};
      }
    });
    res.json(out);
  });

  router.put('/layouts/:reportKey', (req, res) => {
    if (!REPORT_KEYS.includes(req.params.reportKey)) return res.status(404).json({ error: 'Unknown report.' });
    const layout = req.body?.layout && typeof req.body.layout === 'object' ? req.body.layout : {};
    run(
      `INSERT INTO user_report_layouts (user_id, report_key, layout_json, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, report_key) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
      [req.user.id, req.params.reportKey, JSON.stringify(layout)]
    );
    res.json({ ok: true });
  });

  router.get('/calls.xlsx', async (req, res) => {
    const data = computeCallsReport(req.query);
    const staffLookup = idNameMap(all('SELECT id, name FROM users'));
    const wb = buildCallsWorkbook(data, req.query, staffLookup);
    await sendWorkbook(res, wb, 'calls-report');
  });

  router.get('/tech.xlsx', async (req, res) => {
    const data = computeTechReport(req.query);
    const lookups = {
      technicians: idNameMap(all('SELECT id, name FROM technicians')),
      trades: idNameMap(all('SELECT id, name FROM trades')),
    };
    const wb = buildTechWorkbook(data, req.query, lookups);
    await sendWorkbook(res, wb, 'technician-sales-report');
  });

  return router;
}
