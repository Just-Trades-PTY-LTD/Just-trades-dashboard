import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listActive, listClosed, listReviewHistory, dismissItem, reopenItem, activeCount, NeedsAttentionError } from '../services/needsAttention.js';

// Needs Attention (Stage 4): office users only — every Admin and Staff
// account. Technician accounts are refused here (and by the technician gate
// before this router is ever reached). Reading never changes a record; the
// only writes are "Reviewed — leave as is" and reopening, both recorded.
function officeOnly(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Needs Attention is for office accounts only.' });
  next();
}

const handle = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (err) {
    if (err instanceof NeedsAttentionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

export function createNeedsAttentionRouter() {
  const router = Router();
  router.use(requireAuth, officeOnly);
  router.get('/', handle((req) => listActive({ userId: req.user.id, mine: req.query.mine === '1' })));
  router.get('/count', handle(() => ({ count: activeCount() })));
  router.get('/closed', handle(() => ({ items: listClosed() })));
  router.get('/history', handle(() => ({ events: listReviewHistory() })));
  router.post('/dismiss', handle((req) => dismissItem({ key: String(req.body?.key || ''), reason: req.body?.reason, user: req.user })));
  router.post('/reopen', handle((req) => reopenItem({ key: String(req.body?.key || ''), user: req.user })));
  return router;
}
