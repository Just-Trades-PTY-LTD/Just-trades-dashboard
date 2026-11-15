import { all, get, run } from '../db/index.js';

// Settings & accounts Activity history: every change to Lists, Trades, Job
// types, staff accounts and CRM settings. Separate from audit_log (which only
// accepts record types) so nothing existing had to be rebuilt. Each entry
// keeps the names at the time (who did it, and what it was called) as well as
// the link to the person's account — an account with entries here counts as
// linked, so it can only be soft-removed, never permanently deleted.

export function recordSettingsActivity({ entityType, entityId, label, action, changes = {}, user }) {
  run(
    `INSERT INTO settings_activity (entity_type, entity_id, entity_label, action, changes_json, changed_by_user_id, changed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entityType, entityId ?? null, String(label ?? ''), action, JSON.stringify(changes || {}), user?.id ?? null, String(user?.name ?? 'Unknown')]
  );
}

const TYPE_LABELS = { list_item: 'List item', trade: 'Trade', job_type: 'Job type', user: 'Account', technician: 'Technician', setting: 'Setting' };

/** Read-only feed, newest first. The person is shown by their current name
 * (marked "(removed)" for a removed account), or by the name saved with the
 * entry if the account no longer exists. */
export function listSettingsActivity({ from, to, entityType, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('s.changed_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('s.changed_at <= ?');
    params.push(`${to}T23:59:59`);
  }
  if (entityType) {
    where.push('s.entity_type = ?');
    params.push(entityType);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM settings_activity s ${whereSql}`, params).n;
  const rows = all(
    `SELECT s.*, u.name AS current_name, u.removed_at AS by_removed
     FROM settings_activity s LEFT JOIN users u ON u.id = s.changed_by_user_id
     ${whereSql} ORDER BY s.changed_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      at: r.changed_at,
      by: r.current_name ? `${r.current_name}${r.by_removed ? ' (removed)' : ''}` : r.changed_by_name,
      entityType: r.entity_type,
      entityTypeLabel: TYPE_LABELS[r.entity_type] || r.entity_type,
      entityId: r.entity_id,
      record: r.entity_label,
      action: r.action,
      changes: JSON.parse(r.changes_json || '{}'),
    })),
  };
}
