import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { FilterSelect } from '../../components/Fields.jsx';

// Settings & accounts changes: Lists, Trades, Job types, technicians, staff
// accounts and CRM settings. Read-only.
const TYPES = [
  { id: 'list_item', name: 'List item' },
  { id: 'trade', name: 'Trade' },
  { id: 'job_type', name: 'Job type' },
  { id: 'technician', name: 'Technician' },
  { id: 'user', name: 'Account' },
  { id: 'setting', name: 'Setting' },
];
const ACTIONS = {
  added: 'Added',
  renamed: 'Renamed',
  hidden: 'Hidden',
  shown: 'Shown again',
  removed: 'Removed',
  restored: 'Restored',
  deleted: 'Deleted permanently',
  requires_comment: 'Comments rule',
  type_changed: 'Account type changed',
  activated: 'Activated',
  deactivated: 'Deactivated',
  password_reset: 'Password reset',
  email_released: 'Email released',
  changed: 'Changed',
};
const LIST_NAMES = {
  lead_source: 'Lead sources',
  not_booked_reason: 'Not-booked reasons',
  new_job_cancellation_reason: 'New Job Cancellation reasons',
  knockback_reason: 'Knock-back reasons',
  callback_reason: 'Call back reasons',
  pending_cancellation_reason: 'Pending Cancellation reasons',
};
const FIELD_NAMES = { name: 'Name', type: 'Account type', requiresComment: 'Requires comments', leadSource: 'Lead Source', email: 'Email', list: 'List', jobTypes: 'Job types' };
const show = (field, v) => (v === null || v === undefined || v === '' ? '—' : field === 'list' ? LIST_NAMES[v] || v : String(v));

export function describeSettingsChanges(changes) {
  const parts = Object.entries(changes || {}).map(([f, ch]) => `${FIELD_NAMES[f] || f}: ${show(f, ch?.from)} → ${show(f, ch?.to)}`);
  return parts.length ? parts.join(', ') : '—';
}

export default function SettingsActivity() {
  const [entityType, setEntityType] = useState('');
  const [data, setData] = useState(null);
  useEffect(() => {
    api.audit.settingsActivity({ entityType }).then(setData).catch(() => setData({ total: 0, rows: [] }));
  }, [entityType]);
  return (
    <div style={{ marginTop: 24 }} data-testid="settings-activity">
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Settings &amp; accounts changes</div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
        Changes to Lists, Trades, Job types, technicians, staff accounts and CRM settings — who made them and when. Names are shown as they
        were at the time of each change.
      </div>
      <div className="panel" style={{ padding: 12, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <FilterSelect label="What" value={entityType} onChange={setEntityType} options={TYPES} />
        {data && <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink-muted)' }}>{data.total} changes</div>}
      </div>
      <div className="panel table-scroll">
        {!data ? (
          <div className="empty-state">Loading…</div>
        ) : data.rows.length === 0 ? (
          <div className="empty-state">No settings or account changes recorded yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date / time</th>
                <th>By</th>
                <th>Action</th>
                <th>What</th>
                <th>Item / account</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{(r.at || '').replace('T', ' ')}</td>
                  <td>{r.by}</td>
                  <td>
                    <span className="badge badge-info">{ACTIONS[r.action] || r.action}</span>
                  </td>
                  <td>{r.entityTypeLabel}</td>
                  <td>{r.record}</td>
                  <td style={{ fontSize: 12 }}>{describeSettingsChanges(r.changes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
