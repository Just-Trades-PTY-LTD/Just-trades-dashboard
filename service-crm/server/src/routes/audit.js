import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { listActivity } from '../lib/audit.js';
import { listSettingsActivity } from '../lib/settingsActivity.js';

export function createAuditRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/activity', requireAdmin, (req, res) => {
    const { from, to, userId, entityType, page } = req.query;
    const limit = 100;
    const p = Math.max(1, Number(page) || 1);
    res.json(listActivity({ from, to, userId, entityType, limit, offset: (p - 1) * limit }));
  });

  // Settings & accounts changes (Lists, Trades, Job types, accounts, CRM
  // settings) — read-only, admin only.
  router.get('/settings-activity', requireAdmin, (req, res) => {
    const { from, to, entityType, page } = req.query;
    const limit = 100;
    const p = Math.max(1, Number(page) || 1);
    res.json(listSettingsActivity({ from, to, entityType, limit, offset: (p - 1) * limit }));
  });

  return router;
}
