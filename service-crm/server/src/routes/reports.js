import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { computeCallsReport, computeTechReport } from '../services/reports.js';

export function createReportsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/calls', (req, res) => {
    res.json(computeCallsReport(req.query));
  });

  router.get('/tech', (req, res) => {
    res.json(computeTechReport(req.query));
  });

  return router;
}
