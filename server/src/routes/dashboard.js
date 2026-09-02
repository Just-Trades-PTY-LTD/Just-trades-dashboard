import { Router } from 'express';
import { buildDashboard } from '../services/aggregate.js';

export function createDashboardRouter({ aroflo, config }) {
  const router = Router();

  let cache = null;
  let cacheError = null;

  async function refresh() {
    try {
      const [staff, jobs, timesheets] = await Promise.all([
        aroflo.listStaff(),
        aroflo.listJobs(),
        aroflo.listTimesheets(),
      ]);
      cache = buildDashboard({ staff, jobs, timesheets });
      cacheError = null;
    } catch (err) {
      cacheError = err.message;
      // eslint-disable-next-line no-console
      console.error('Failed to refresh AroFlo data:', err.message);
    }
  }

  refresh();
  setInterval(refresh, config.refreshIntervalMs);

  router.get('/dashboard', (req, res) => {
    if (!cache) {
      return res.status(cacheError ? 502 : 503).json({ error: cacheError || 'Data not yet available' });
    }
    res.json({ ...cache, mode: config.aroflo.mode });
  });

  router.post('/dashboard/refresh', async (req, res) => {
    await refresh();
    if (!cache) return res.status(502).json({ error: cacheError });
    res.json({ ...cache, mode: config.aroflo.mode });
  });

  return router;
}
