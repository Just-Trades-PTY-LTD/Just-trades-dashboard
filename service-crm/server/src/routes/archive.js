import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { ArchiveError, applyArchive, applyLinkQal, describePlans, planMany, previewLinkQal } from '../lib/archive.js';

// Archive / unarchive (admins only) — one or several Technician & Sales
// entries or calls. Two steps, so nothing is archived without the admin
// seeing exactly what will change: POST /preview returns the plan (counts
// by type, every linked change, linked records left alone, and a token);
// POST /apply with that token applies it in one transaction, or refuses if
// the records involved have changed since. See lib/archive.js.
//   body: { items: [{ kind, id }], archived: true | false, token }
export function createArchiveRouter() {
  const router = Router();
  router.use(requireAuth, requireAdmin);

  const handle = (fn) => (req, res) => {
    try {
      res.json(fn(req.body || {}, req));
    } catch (err) {
      if (err instanceof ArchiveError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };

  router.post('/preview', handle((b) => describePlans(planMany(b.items, !!b.archived))));
  router.post('/apply', handle((b, req) => ({ ok: true, ...applyArchive(b.items, !!b.archived, b.token, req.user.id) })));

  // Link an unlinked Quote Approved Later sale to the original knock-back
  // job it was saved against — same preview -> confirm -> apply flow.
  //   body: { saleId, token }
  router.post('/link-qal/preview', handle((b) => previewLinkQal(b.saleId)));
  router.post('/link-qal/apply', handle((b, req) => ({ ok: true, ...applyLinkQal(b.saleId, b.token, req.user.id) })));

  return router;
}
