import { all, get, run } from '../db/index.js';

/**
 * Compares `before` and `after` on the given fields and, if anything
 * changed, writes one audit_log row recording all of those changes together
 * (mirrors the prototype's per-save _history entry).
 */
export function recordAudit({ entityType, entityId, before, after, fields, userId }) {
  const changes = {};
  for (const field of fields) {
    const from = before ? before[field] ?? null : null;
    const to = after[field] ?? null;
    if (String(from ?? '') !== String(to ?? '')) changes[field] = { from, to };
  }
  if (Object.keys(changes).length === 0) return;
  run('INSERT INTO audit_log (entity_type, entity_id, changes_json, changed_by_user_id) VALUES (?, ?, ?, ?)', [
    entityType,
    entityId,
    JSON.stringify(changes),
    userId || null,
  ]);
}

export function getHistory(entityType, entityId) {
  const rows = all(
    `SELECT a.id, a.changes_json, a.changed_at, u.name AS changed_by
     FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by_user_id
     WHERE a.entity_type = ? AND a.entity_id = ?
     ORDER BY a.changed_at DESC, a.id DESC`,
    [entityType, entityId]
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.changed_at,
    by: r.changed_by || 'Unknown',
    changes: JSON.parse(r.changes_json),
  }));
}

export function getHistoryCounts(entityType, ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT entity_id, COUNT(*) AS n FROM audit_log WHERE entity_type = ? AND entity_id IN (${placeholders}) GROUP BY entity_id`,
    [entityType, ...ids]
  );
  const map = {};
  rows.forEach((r) => {
    map[r.entity_id] = r.n;
  });
  return map;
}

// How to label one record of a given entity type in the activity feed, and
// which live table to look it up in (it may since have been deleted).
const ENTITY_LOOKUP = {
  call: {
    table: 'calls',
    select: 'id, job_number, call_type',
    label: (r) => `${r.call_type} call${r.job_number ? ` — JN ${r.job_number}` : ''}`,
  },
  job: {
    table: 'jobs',
    select: 'id, job_number',
    label: (r) => `Job — JN ${r.job_number || '—'}`,
  },
  sale: {
    table: 'sales',
    select: 'id, job_number, invoice_number',
    label: (r) => `Sale — JN ${r.job_number || '—'}${r.invoice_number ? ` (inv. ${r.invoice_number})` : ''}`,
  },
  call_back: {
    table: 'call_backs',
    select: 'id, job_number',
    label: (r) => `Call back — JN ${r.job_number || '—'}`,
  },
  pending_cancellation: {
    table: 'pending_cancellations',
    select: 'id, job_number',
    label: (r) => `Pending cancellation — JN ${r.job_number || '—'}`,
  },
};

export const ENTITY_TYPE_LABELS = {
  call: 'Call',
  job: 'Job',
  sale: 'Sale',
  call_back: 'Call back',
  pending_cancellation: 'Pending cancellation',
};

/** Read-only, admin-facing feed across every audit_log entry — who did what,
 * when, to which record, and whether it was the record's creation or a later
 * edit. Never writes anything; entirely derived from data recordAudit()
 * already writes on every create/edit. */
export function listActivity({ from, to, userId, entityType, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('a.changed_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('a.changed_at <= ?');
    params.push(`${to}T23:59:59`);
  }
  if (userId) {
    where.push('a.changed_by_user_id = ?');
    params.push(userId);
  }
  if (entityType) {
    where.push('a.entity_type = ?');
    params.push(entityType);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = get(`SELECT COUNT(*) AS n FROM audit_log a ${whereSql}`, params).n;

  const rows = all(
    `SELECT a.id, a.entity_type, a.entity_id, a.changes_json, a.changed_at, u.name AS changed_by,
       (a.id = (SELECT MIN(id) FROM audit_log WHERE entity_type = a.entity_type AND entity_id = a.entity_id)) AS is_created
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.changed_by_user_id
     ${whereSql}
     ORDER BY a.changed_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Batch-fetch a human label for every referenced record, grouped by type —
  // one small query per entity type touched on this page, not one per row.
  const idsByType = {};
  rows.forEach((r) => {
    (idsByType[r.entity_type] ||= new Set()).add(r.entity_id);
  });
  const labelsByType = {};
  Object.entries(idsByType).forEach(([type, idSet]) => {
    const cfg = ENTITY_LOOKUP[type];
    if (!cfg) return;
    const ids = [...idSet];
    const placeholders = ids.map(() => '?').join(',');
    const found = all(`SELECT ${cfg.select} FROM ${cfg.table} WHERE id IN (${placeholders})`, ids);
    labelsByType[type] = {};
    found.forEach((r) => {
      labelsByType[type][r.id] = cfg.label(r);
    });
  });

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      at: r.changed_at,
      by: r.changed_by || 'Unknown',
      action: r.is_created ? 'created' : 'edited',
      entityType: r.entity_type,
      entityTypeLabel: ENTITY_TYPE_LABELS[r.entity_type] || r.entity_type,
      entityId: r.entity_id,
      record: labelsByType[r.entity_type]?.[r.entity_id] || `${ENTITY_TYPE_LABELS[r.entity_type] || r.entity_type} #${r.entity_id} (deleted)`,
      changes: JSON.parse(r.changes_json),
    })),
  };
}
