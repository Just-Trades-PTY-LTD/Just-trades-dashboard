import { Router } from 'express';
import { all, get, prepare, run } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

const LIST_CATEGORIES = [
  'lead_source',
  'not_booked_reason',
  'new_job_cancellation_reason',
  'pending_job_cancellation_reason',
  'knockback_reason',
  'callback_reason',
  'pending_cancellation_reason',
];

function nextSortOrder(table, whereSql = '1=1', params = []) {
  const row = get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${table} WHERE ${whereSql}`, params);
  return row.m + 1;
}

export function createSettingsRouter() {
  const router = Router();
  router.use(requireAuth);

  // ---- Read-only bundle: everything a form/report needs to populate dropdowns ----
  router.get('/bundle', (req, res) => {
    const trades = all('SELECT * FROM trades ORDER BY sort_order').map((t) => ({
      id: t.id,
      name: t.name,
      jobTypes: all('SELECT id, name FROM job_types WHERE trade_id = ? ORDER BY sort_order', [t.id]),
    }));
    const technicians = all('SELECT id, name, active FROM technicians ORDER BY sort_order');
    const lists = {};
    LIST_CATEGORIES.forEach((cat) => {
      lists[cat] = all('SELECT id, name FROM list_items WHERE category = ? ORDER BY sort_order', [cat]);
    });
    const suburbCount = get('SELECT COUNT(*) AS n FROM suburbs').n;
    res.json({ trades, technicians, lists, suburbCount });
  });

  const adminOnly = requireAdmin;

  // ---- Trades & job types ----
  router.post('/trades', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const { lastInsertRowid } = run('INSERT INTO trades (name, sort_order) VALUES (?, ?)', [name, nextSortOrder('trades')]);
    res.status(201).json(get('SELECT * FROM trades WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/trades/:id', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    run('UPDATE trades SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json(get('SELECT * FROM trades WHERE id = ?', [req.params.id]));
  });

  router.delete('/trades/:id', adminOnly, (req, res) => {
    run('DELETE FROM trades WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  router.post('/trades/:id/job-types', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const tradeId = req.params.id;
    const { lastInsertRowid } = run('INSERT INTO job_types (trade_id, name, sort_order) VALUES (?, ?, ?)', [
      tradeId,
      name,
      nextSortOrder('job_types', 'trade_id = ?', [tradeId]),
    ]);
    res.status(201).json(get('SELECT * FROM job_types WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/job-types/:id', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    run('UPDATE job_types SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json(get('SELECT * FROM job_types WHERE id = ?', [req.params.id]));
  });

  router.delete('/job-types/:id', adminOnly, (req, res) => {
    run('DELETE FROM job_types WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- Technicians ----
  router.post('/technicians', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const { lastInsertRowid } = run('INSERT INTO technicians (name, sort_order) VALUES (?, ?)', [name, nextSortOrder('technicians')]);
    res.status(201).json(get('SELECT * FROM technicians WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/technicians/:id', adminOnly, (req, res) => {
    const { name, active } = req.body || {};
    if (name !== undefined) run('UPDATE technicians SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    if (active !== undefined) run('UPDATE technicians SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    res.json(get('SELECT * FROM technicians WHERE id = ?', [req.params.id]));
  });

  router.delete('/technicians/:id', adminOnly, (req, res) => {
    run('DELETE FROM technicians WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- Generic reason/source lists ----
  function checkCategory(req, res, next) {
    if (!LIST_CATEGORIES.includes(req.params.category)) return res.status(404).json({ error: 'Unknown list category.' });
    next();
  }

  router.get('/lists/:category', checkCategory, (req, res) => {
    res.json(all('SELECT id, name FROM list_items WHERE category = ? ORDER BY sort_order', [req.params.category]));
  });

  router.post('/lists/:category', adminOnly, checkCategory, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const { category } = req.params;
    const { lastInsertRowid } = run('INSERT INTO list_items (category, name, sort_order) VALUES (?, ?, ?)', [
      category,
      name,
      nextSortOrder('list_items', 'category = ?', [category]),
    ]);
    res.status(201).json(get('SELECT id, name FROM list_items WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/list-items/:id', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    run('UPDATE list_items SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json(get('SELECT id, name FROM list_items WHERE id = ?', [req.params.id]));
  });

  router.delete('/list-items/:id', adminOnly, (req, res) => {
    run('DELETE FROM list_items WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ---- Suburbs ----
  router.get('/suburbs', (req, res) => {
    const search = (req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    let where = '1=1';
    const params = [];
    if (search) {
      where = '(name LIKE ? OR postcode LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    const total = get(`SELECT COUNT(*) AS n FROM suburbs WHERE ${where}`, params).n;
    const rows = all(`SELECT * FROM suburbs WHERE ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    res.json({ rows, total, page, pageSize });
  });

  router.get('/suburbs/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json(all('SELECT * FROM suburbs ORDER BY name COLLATE NOCASE LIMIT 30'));
    res.json(
      all('SELECT * FROM suburbs WHERE name LIKE ? OR postcode LIKE ? ORDER BY name COLLATE NOCASE LIMIT 30', [`%${q}%`, `%${q}%`])
    );
  });

  router.post('/suburbs', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    const postcode = (req.body?.postcode || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    try {
      const { lastInsertRowid } = run('INSERT INTO suburbs (name, postcode) VALUES (?, ?)', [name, postcode]);
      res.status(201).json(get('SELECT * FROM suburbs WHERE id = ?', [lastInsertRowid]));
    } catch {
      res.status(409).json({ error: 'That suburb/postcode combination already exists.' });
    }
  });

  router.patch('/suburbs/:id', adminOnly, (req, res) => {
    const { name, postcode } = req.body || {};
    if (name !== undefined) run('UPDATE suburbs SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    if (postcode !== undefined) run('UPDATE suburbs SET postcode = ? WHERE id = ?', [postcode.trim(), req.params.id]);
    res.json(get('SELECT * FROM suburbs WHERE id = ?', [req.params.id]));
  });

  router.delete('/suburbs/:id', adminOnly, (req, res) => {
    run('DELETE FROM suburbs WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  router.post('/suburbs/bulk-import', adminOnly, (req, res) => {
    const text = req.body?.text || '';
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const insert = prepare('INSERT INTO suburbs (name, postcode) VALUES (?, ?)');
    let added = 0;
    let skippedDup = 0;
    const rejected = [];
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      const name = parts[0];
      const postcode = parts[1] || '';
      if (!name || (postcode && !/^\d{4}$/.test(postcode))) {
        rejected.push(line);
        continue;
      }
      const exists = get('SELECT id FROM suburbs WHERE name = ? AND postcode = ?', [name, postcode]);
      if (exists) {
        skippedDup += 1;
        continue;
      }
      try {
        insert.run(name, postcode);
        added += 1;
      } catch {
        rejected.push(line);
      }
    }
    res.json({ added, skippedDup, rejected });
  });

  return router;
}

export { LIST_CATEGORIES };
