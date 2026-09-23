import { Router } from 'express';
import { all } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { computeCallsReport, computeTechReport } from '../services/reports.js';
import { buildCallsWorkbook, buildTechWorkbook } from '../lib/xlsxReports.js';

function idNameMap(rows) {
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

async function sendWorkbook(res, workbook, filenamePrefix) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

export function createReportsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/calls', (req, res) => {
    res.json(computeCallsReport(req.query));
  });

  router.get('/tech', (req, res) => {
    res.json(computeTechReport(req.query));
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
