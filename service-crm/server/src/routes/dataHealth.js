import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { runDataHealthChecks } from '../services/dataHealth.js';

// Settings -> Data health (admins only). Read-only: GET only, and every
// check is a SELECT — see services/dataHealth.js.
export function createDataHealthRouter() {
  const router = Router();
  router.use(requireAuth, requireAdmin);
  router.get('/', (req, res) => res.json(runDataHealthChecks()));
  return router;
}
