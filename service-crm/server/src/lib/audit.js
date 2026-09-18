import { all, run } from '../db/index.js';

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
     ORDER BY a.changed_at DESC`,
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
