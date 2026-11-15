import { Router } from 'express';
import { all, get, prepare, run } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { listMappingsForSettings, validateMappings, saveMappings } from '../aroflo/taskTypeMapping.js';
import { listLeadSourceMappingsForSettings, validateLeadSourceMappings, saveLeadSourceMappings } from '../aroflo/leadSourceMapping.js';
import { getFollowUpDefaultDueDays } from './followUps.js';

import {
  LIST_CATEGORIES,
  REASON_CATEGORIES,
  REPEAT_CUSTOMER_SETTING,
  nameProblem,
  freeName,
  usageOf,
  usageMap,
  repeatCustomerLeadSource,
} from '../services/settingsCatalog.js';
import { recordSettingsActivity } from '../lib/settingsActivity.js';

function nextSortOrder(table, whereSql = '1=1', params = []) {
  const row = get(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${table} WHERE ${whereSql}`, params);
  return row.m + 1;
}

// Every column across jobs/sales/call_backs/pending_cancellations/
// review_technicians that can reference a technician — a technician
// referenced by any of these (active or archived) can never be permanently
// deleted, only deactivated, since the FOREIGN KEY on each of these columns
// would refuse the delete outright.
function technicianIdsWithLinkedRecords() {
  const ids = new Set();
  [
    'SELECT DISTINCT technician_id AS id FROM jobs WHERE technician_id IS NOT NULL',
    'SELECT DISTINCT install_technician_id AS id FROM jobs WHERE install_technician_id IS NOT NULL',
    'SELECT DISTINCT credited_technician_id AS id FROM sales WHERE credited_technician_id IS NOT NULL',
    'SELECT DISTINCT attending_technician_id AS id FROM call_backs WHERE attending_technician_id IS NOT NULL',
    'SELECT DISTINCT credited_technician_id AS id FROM call_backs WHERE credited_technician_id IS NOT NULL',
    'SELECT DISTINCT credited_technician_id AS id FROM pending_cancellations WHERE credited_technician_id IS NOT NULL',
    'SELECT DISTINCT technician_id AS id FROM review_technicians',
  ].forEach((sql) => all(sql).forEach((r) => ids.add(r.id)));
  return ids;
}

export function createSettingsRouter() {
  const router = Router();
  router.use(requireAuth);

  // ---- Read-only bundle: everything a form/report needs to populate dropdowns ----
  router.get('/bundle', (req, res) => {
    // Hidden items stay in the bundle (flagged) so saved records, filters and
    // reports still show them; forms only offer visible ones for new entries.
    const trades = all('SELECT * FROM trades ORDER BY sort_order').map((t) => ({
      id: t.id,
      name: t.name,
      hidden: !!t.hidden_at,
      jobTypes: all('SELECT id, name, hidden_at FROM job_types WHERE trade_id = ? ORDER BY sort_order', [t.id]).map((jt) => ({
        id: jt.id,
        name: jt.name,
        hidden: !!jt.hidden_at || !!t.hidden_at,
        ownHidden: !!jt.hidden_at,
      })),
    }));
    const linkedTechnicianIds = technicianIdsWithLinkedRecords();
    const technicians = all('SELECT id, name, active FROM technicians ORDER BY sort_order').map((t) => ({
      ...t,
      active: !!t.active,
      canDelete: !linkedTechnicianIds.has(t.id),
    }));
    const lists = {};
    LIST_CATEGORIES.forEach((cat) => {
      lists[cat] = all('SELECT id, name, hidden_at, requires_comment FROM list_items WHERE category = ? ORDER BY sort_order', [cat]).map((i) => ({
        id: i.id,
        name: i.name,
        hidden: !!i.hidden_at,
        requiresComment: !!i.requires_comment,
      }));
    });
    const suburbCount = get('SELECT COUNT(*) AS n FROM suburbs').n;
    const repeat = repeatCustomerLeadSource();
    res.json({
      trades,
      technicians,
      lists,
      suburbCount,
      followUpDefaultDueDays: getFollowUpDefaultDueDays(),
      repeatCustomerLeadSourceId: repeat.id,
      repeatCustomerSource: repeat.source,
    });
  });

  const adminOnly = requireAdmin;

  // ---- Quote Follow-up trial: configurable default due-days ----
  router.patch('/follow-up-default-due-days', adminOnly, (req, res) => {
    const days = Number(req.body?.days);
    if (!Number.isFinite(days) || days < 1 || !Number.isInteger(days)) {
      return res.status(400).json({ error: 'Please enter a whole number of days (1 or more).' });
    }
    run(
      `INSERT INTO app_settings (key, value) VALUES ('follow_up_default_due_days', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(days)]
    );
    res.json({ followUpDefaultDueDays: getFollowUpDefaultDueDays() });
  });

  // ---- AroFlo task type -> Trade / Job type mappings (admin only) ----
  // Stored in app_settings (included in backup/restore). Only shapes future
  // AroFlo lookups — never changes any saved call or job.
  router.get('/aroflo-task-type-mappings', adminOnly, (req, res) => {
    res.json({ mappings: listMappingsForSettings() });
  });

  router.put('/aroflo-task-type-mappings', adminOnly, (req, res) => {
    const { mappings, error } = validateMappings(req.body?.mappings);
    if (error) return res.status(400).json({ error });
    saveMappings(mappings);
    res.json({ mappings: listMappingsForSettings() });
  });

  // ---- AroFlo Lead Source value -> CRM Lead Source mappings (admin only) ----
  // Stored in app_settings (included in backup/restore). Only shapes future
  // call-form suggestions — never changes any saved call.
  router.get('/aroflo-lead-source-mappings', adminOnly, (req, res) => {
    res.json({ mappings: listLeadSourceMappingsForSettings() });
  });

  router.put('/aroflo-lead-source-mappings', adminOnly, (req, res) => {
    const { mappings, error } = validateLeadSourceMappings(req.body?.mappings);
    if (error) return res.status(400).json({ error });
    saveLeadSourceMappings(mappings);
    res.json({ mappings: listLeadSourceMappingsForSettings() });
  });

  // ---- Trades & job types ----
  // Admin-only. Rename keeps the same item (every record shows the new name);
  // Hide takes it out of new entries (a hidden Trade's Job types too) while
  // saved records and reports keep it; Remove only for unused items.
  const tradeRow = (id) => get('SELECT * FROM trades WHERE id = ?', [id]);
  const jobTypeRow = (id) => get('SELECT jt.*, t.name AS trade_name FROM job_types jt JOIN trades t ON t.id = jt.trade_id WHERE jt.id = ?', [id]);

  router.post('/trades', adminOnly, (req, res) => {
    const name = req.body?.name ? String(req.body.name).trim() : freeName('New trade', { table: 'trades' });
    const problem = nameProblem(name, { table: 'trades' });
    if (problem) return res.status(400).json({ error: problem });
    const { lastInsertRowid } = run('INSERT INTO trades (name, sort_order) VALUES (?, ?)', [name, nextSortOrder('trades')]);
    recordSettingsActivity({ entityType: 'trade', entityId: Number(lastInsertRowid), label: name, action: 'added', user: req.user });
    res.status(201).json(tradeRow(lastInsertRowid));
  });

  router.patch('/trades/:id', adminOnly, (req, res) => {
    const t = tradeRow(req.params.id);
    if (!t) return res.status(404).json({ error: 'Trade not found.' });
    const name = String(req.body?.name ?? '').trim();
    if (name === t.name) return res.json(t);
    const problem = nameProblem(name, { table: 'trades', excludeId: t.id });
    if (problem) return res.status(400).json({ error: problem });
    run('UPDATE trades SET name = ? WHERE id = ?', [name, t.id]);
    recordSettingsActivity({ entityType: 'trade', entityId: t.id, label: name, action: 'renamed', changes: { name: { from: t.name, to: name } }, user: req.user });
    res.json(tradeRow(t.id));
  });

  router.patch('/trades/:id/hidden', adminOnly, (req, res) => {
    const t = tradeRow(req.params.id);
    if (!t) return res.status(404).json({ error: 'Trade not found.' });
    const hide = !!req.body?.hidden;
    if (hide === !!t.hidden_at) return res.json(tradeRow(t.id));
    run(`UPDATE trades SET hidden_at = ${hide ? "datetime('now')" : 'NULL'} WHERE id = ?`, [t.id]);
    recordSettingsActivity({ entityType: 'trade', entityId: t.id, label: t.name, action: hide ? 'hidden' : 'shown', user: req.user });
    res.json(tradeRow(t.id));
  });

  router.delete('/trades/:id', adminOnly, (req, res) => {
    const t = tradeRow(req.params.id);
    if (!t) return res.status(404).json({ error: 'Trade not found.' });
    const used = usageOf('trades', t.id);
    const jobTypeUse = all('SELECT id FROM job_types WHERE trade_id = ?', [t.id]).reduce((n, jt) => n + usageOf('job_types', jt.id).total, 0);
    if (used.total || jobTypeUse) {
      const what = [used.text, jobTypeUse ? `${jobTypeUse} record${jobTypeUse === 1 ? '' : 's'} using its Job types` : ''].filter(Boolean).join(', ');
      return res.status(409).json({ error: `"${t.name}" is used by ${what}, so it can't be removed — hide it instead. Nothing was changed.` });
    }
    const jobTypes = all('SELECT name FROM job_types WHERE trade_id = ?', [t.id]).map((j) => j.name);
    run('DELETE FROM trades WHERE id = ?', [t.id]);
    recordSettingsActivity({ entityType: 'trade', entityId: t.id, label: t.name, action: 'removed', changes: jobTypes.length ? { jobTypes: { from: jobTypes.join(', '), to: null } } : {}, user: req.user });
    res.json({ ok: true });
  });

  router.post('/trades/:id/job-types', adminOnly, (req, res) => {
    const t = tradeRow(req.params.id);
    if (!t) return res.status(404).json({ error: 'Trade not found.' });
    const scope = { table: 'job_types', tradeId: t.id };
    const name = req.body?.name && String(req.body.name).trim() !== 'New job type' ? String(req.body.name).trim() : freeName('New job type', scope);
    const problem = nameProblem(name, scope);
    if (problem) return res.status(400).json({ error: problem });
    const { lastInsertRowid } = run('INSERT INTO job_types (trade_id, name, sort_order) VALUES (?, ?, ?)', [
      t.id,
      name,
      nextSortOrder('job_types', 'trade_id = ?', [t.id]),
    ]);
    recordSettingsActivity({ entityType: 'job_type', entityId: Number(lastInsertRowid), label: `${t.name} — ${name}`, action: 'added', user: req.user });
    res.status(201).json(get('SELECT * FROM job_types WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/job-types/:id', adminOnly, (req, res) => {
    const jt = jobTypeRow(req.params.id);
    if (!jt) return res.status(404).json({ error: 'Job type not found.' });
    const name = String(req.body?.name ?? '').trim();
    if (name === jt.name) return res.json(jt);
    const problem = nameProblem(name, { table: 'job_types', tradeId: jt.trade_id, excludeId: jt.id });
    if (problem) return res.status(400).json({ error: problem });
    run('UPDATE job_types SET name = ? WHERE id = ?', [name, jt.id]);
    recordSettingsActivity({ entityType: 'job_type', entityId: jt.id, label: `${jt.trade_name} — ${name}`, action: 'renamed', changes: { name: { from: jt.name, to: name } }, user: req.user });
    res.json(jobTypeRow(jt.id));
  });

  router.patch('/job-types/:id/hidden', adminOnly, (req, res) => {
    const jt = jobTypeRow(req.params.id);
    if (!jt) return res.status(404).json({ error: 'Job type not found.' });
    const hide = !!req.body?.hidden;
    if (hide === !!jt.hidden_at) return res.json(jt);
    run(`UPDATE job_types SET hidden_at = ${hide ? "datetime('now')" : 'NULL'} WHERE id = ?`, [jt.id]);
    recordSettingsActivity({ entityType: 'job_type', entityId: jt.id, label: `${jt.trade_name} — ${jt.name}`, action: hide ? 'hidden' : 'shown', user: req.user });
    res.json(jobTypeRow(jt.id));
  });

  router.delete('/job-types/:id', adminOnly, (req, res) => {
    const jt = jobTypeRow(req.params.id);
    if (!jt) return res.status(404).json({ error: 'Job type not found.' });
    const used = usageOf('job_types', jt.id);
    if (used.total) return res.status(409).json({ error: `"${jt.name}" is used by ${used.text}, so it can't be removed — hide it instead. Nothing was changed.` });
    run('DELETE FROM job_types WHERE id = ?', [jt.id]);
    recordSettingsActivity({ entityType: 'job_type', entityId: jt.id, label: `${jt.trade_name} — ${jt.name}`, action: 'removed', user: req.user });
    res.json({ ok: true });
  });

  // Usage counts for the Settings screen (admin only): how many records use
  // each item, so Remove / Hide can say so up front.
  router.get('/usage', adminOnly, (req, res) => {
    const toObj = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
    res.json({ listItems: toObj(usageMap('list_items')), trades: toObj(usageMap('trades')), jobTypes: toObj(usageMap('job_types')) });
  });

  // ---- Technicians ----
  router.post('/technicians', adminOnly, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const { lastInsertRowid } = run('INSERT INTO technicians (name, sort_order) VALUES (?, ?)', [name, nextSortOrder('technicians')]);
    recordSettingsActivity({ entityType: 'technician', entityId: Number(lastInsertRowid), label: name, action: 'added', user: req.user });
    res.status(201).json(get('SELECT * FROM technicians WHERE id = ?', [lastInsertRowid]));
  });

  router.patch('/technicians/:id', adminOnly, (req, res) => {
    const { name, active } = req.body || {};
    const before = get('SELECT * FROM technicians WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Technician not found.' });
    // Deactivating / reactivating a technician never changes a linked
    // account's type: a Technician account stays a Technician account and is
    // blocked while this record is inactive (see middleware/auth.js).
    if (name !== undefined) run('UPDATE technicians SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    if (active !== undefined) run('UPDATE technicians SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    if (name !== undefined && name.trim() !== before.name) {
      recordSettingsActivity({ entityType: 'technician', entityId: before.id, label: name.trim(), action: 'renamed', changes: { name: { from: before.name, to: name.trim() } }, user: req.user });
    }
    if (active !== undefined && !!active !== !!before.active) {
      recordSettingsActivity({ entityType: 'technician', entityId: before.id, label: before.name, action: active ? 'activated' : 'deactivated', user: req.user });
    }
    res.json(get('SELECT * FROM technicians WHERE id = ?', [req.params.id]));
  });

  router.delete('/technicians/:id', adminOnly, (req, res) => {
    // A technician linked to an active Technician account (an open
    // technician_accounts row for an active account) can't be permanently
    // deleted — deactivating the technician still works and blocks that
    // account. Checked here, on the server, since technician_accounts
    // deliberately has no foreign key to technicians.
    const linkedAccount = get(
      `SELECT 1 FROM technician_accounts ta JOIN users u ON u.id = ta.user_id
       WHERE ta.technician_id = ? AND ta.unlinked_at IS NULL AND u.active = 1`,
      [req.params.id]
    );
    if (linkedAccount) {
      return res.status(409).json({
        error:
          'This technician is linked to a Technician account. Change that account back to Staff, link it to another technician, or deactivate the account before deleting this technician.',
      });
    }
    try {
      const tech = get('SELECT name FROM technicians WHERE id = ?', [req.params.id]);
      run('DELETE FROM technicians WHERE id = ?', [req.params.id]);
      if (tech) recordSettingsActivity({ entityType: 'technician', entityId: Number(req.params.id), label: tech.name, action: 'deleted', user: req.user });
      res.json({ ok: true });
    } catch (err) {
      // Mirrors the same FK-constraint backstop used for job/sale/call-back
      // entries — a technician referenced by any existing job, sale, call
      // back or pending cancellation can never be deleted (SQLite's FK check
      // refuses it), only deactivated. This is the client's backstop for a
      // direct API call bypassing the disabled Delete button; the bundle's
      // per-technician canDelete flag is what disables that button in the UI.
      if (String(err.message).includes('FOREIGN KEY constraint failed')) {
        return res.status(409).json({ error: 'This technician has linked records and cannot be permanently deleted. Please deactivate them instead.' });
      }
      throw err;
    }
  });

  // ---- Generic reason/source lists ----
  function checkCategory(req, res, next) {
    if (!LIST_CATEGORIES.includes(req.params.category)) return res.status(404).json({ error: 'Unknown list category.' });
    next();
  }
  const itemRow = (id) => get('SELECT * FROM list_items WHERE id = ?', [id]);
  const itemOut = (i) => i && { id: i.id, name: i.name, category: i.category, hidden: !!i.hidden_at, requiresComment: !!i.requires_comment };
  const isRepeatItem = (i) => i.category === 'lead_source' && repeatCustomerLeadSource().id === i.id;

  router.get('/lists/:category', checkCategory, (req, res) => {
    res.json(all('SELECT * FROM list_items WHERE category = ? ORDER BY sort_order', [req.params.category]).map(itemOut));
  });

  router.post('/lists/:category', adminOnly, checkCategory, (req, res) => {
    const { category } = req.params;
    const scope = { table: 'list_items', category };
    const requested = String(req.body?.name ?? '').trim();
    const name = requested && requested !== 'New item' ? requested : freeName('New item', scope);
    const problem = nameProblem(name, scope);
    if (problem) return res.status(400).json({ error: problem });
    const { lastInsertRowid } = run('INSERT INTO list_items (category, name, sort_order) VALUES (?, ?, ?)', [
      category,
      name,
      nextSortOrder('list_items', 'category = ?', [category]),
    ]);
    recordSettingsActivity({ entityType: 'list_item', entityId: Number(lastInsertRowid), label: name, action: 'added', changes: { list: { from: null, to: category } }, user: req.user });
    res.status(201).json(itemOut(itemRow(lastInsertRowid)));
  });

  router.patch('/list-items/:id', adminOnly, (req, res) => {
    const i = itemRow(req.params.id);
    if (!i) return res.status(404).json({ error: 'Item not found.' });
    const name = String(req.body?.name ?? '').trim();
    if (name === i.name) return res.json(itemOut(i));
    const problem = nameProblem(name, { table: 'list_items', category: i.category, excludeId: i.id });
    if (problem) return res.status(400).json({ error: problem });
    run('UPDATE list_items SET name = ? WHERE id = ?', [name, i.id]);
    recordSettingsActivity({ entityType: 'list_item', entityId: i.id, label: name, action: 'renamed', changes: { name: { from: i.name, to: name } }, user: req.user });
    res.json(itemOut(itemRow(i.id)));
  });

  router.patch('/list-items/:id/hidden', adminOnly, (req, res) => {
    const i = itemRow(req.params.id);
    if (!i) return res.status(404).json({ error: 'Item not found.' });
    const hide = !!req.body?.hidden;
    if (hide === !!i.hidden_at) return res.json(itemOut(i));
    if (hide && isRepeatItem(i)) {
      return res.status(409).json({ error: `"${i.name}" is the Lead Source used for callbacks and repeat customers. Choose a different one in Lead sources first. Nothing was changed.` });
    }
    run(`UPDATE list_items SET hidden_at = ${hide ? "datetime('now')" : 'NULL'} WHERE id = ?`, [i.id]);
    recordSettingsActivity({ entityType: 'list_item', entityId: i.id, label: i.name, action: hide ? 'hidden' : 'shown', user: req.user });
    res.json(itemOut(itemRow(i.id)));
  });

  router.patch('/list-items/:id/requires-comment', adminOnly, (req, res) => {
    const i = itemRow(req.params.id);
    if (!i) return res.status(404).json({ error: 'Item not found.' });
    if (!REASON_CATEGORIES.includes(i.category)) return res.status(400).json({ error: 'Only reasons can require comments.' });
    const on = !!req.body?.requiresComment;
    if (on === !!i.requires_comment) return res.json(itemOut(i));
    run('UPDATE list_items SET requires_comment = ? WHERE id = ?', [on ? 1 : 0, i.id]);
    recordSettingsActivity({ entityType: 'list_item', entityId: i.id, label: i.name, action: 'requires_comment', changes: { requiresComment: { from: !on ? 'Yes' : 'No', to: on ? 'Yes' : 'No' } }, user: req.user });
    res.json(itemOut(itemRow(i.id)));
  });

  router.delete('/list-items/:id', adminOnly, (req, res) => {
    const i = itemRow(req.params.id);
    if (!i) return res.status(404).json({ error: 'Item not found.' });
    if (isRepeatItem(i)) {
      return res.status(409).json({ error: `"${i.name}" is the Lead Source used for callbacks and repeat customers, so it can't be removed. Nothing was changed.` });
    }
    const used = usageOf('list_items', i.id);
    if (used.total) return res.status(409).json({ error: `"${i.name}" is used by ${used.text}, so it can't be removed — hide it instead. Nothing was changed.` });
    run('DELETE FROM list_items WHERE id = ?', [i.id]);
    recordSettingsActivity({ entityType: 'list_item', entityId: i.id, label: i.name, action: 'removed', changes: { list: { from: i.category, to: null } }, user: req.user });
    res.json({ ok: true });
  });

  // The Lead Source callbacks and repeat customers are credited to (by id,
  // so it can be renamed). Admin-only; must be a visible Lead Source.
  router.put('/repeat-customer-lead-source', adminOnly, (req, res) => {
    const i = itemRow(req.body?.leadSourceId);
    if (!i || i.category !== 'lead_source') return res.status(400).json({ error: 'Choose a Lead Source.' });
    if (i.hidden_at) return res.status(400).json({ error: `"${i.name}" is hidden — show it again first.` });
    const before = repeatCustomerLeadSource();
    run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [REPEAT_CUSTOMER_SETTING, String(i.id)]);
    if (before.id !== i.id || before.source !== 'setting') {
      recordSettingsActivity({ entityType: 'setting', entityId: null, label: 'Lead Source for callbacks and repeat customers', action: 'changed', changes: { leadSource: { from: before.id ? before.name : null, to: i.name } }, user: req.user });
    }
    res.json({ repeatCustomerLeadSourceId: i.id });
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
