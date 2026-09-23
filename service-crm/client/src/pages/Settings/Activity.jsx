import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { formatAuditChanges } from '../../lib/audit.js';

const ENTITY_TYPES = [
  { id: 'call', name: 'Call' },
  { id: 'job', name: 'Job' },
  { id: 'sale', name: 'Sale' },
  { id: 'call_back', name: 'Call back' },
  { id: 'pending_cancellation', name: 'Pending cancellation' },
];

function emptyFilters() {
  return { from: '', to: '', userId: '', entityType: '' };
}

export default function Activity() {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [data, setData] = useState(null);

  useEffect(() => {
    api.audit.activity({ from: filters.from, to: filters.to, userId: filters.userId, entityType: filters.entityType }).then(setData);
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Every time a Call or Technician &amp; Sales record is created or edited, it's logged here — who did it, when, and what changed.
        Records created before this history existed won't show a "Created" entry, since that's not something that can be reconstructed
        after the fact — but anything created or edited from now on will.
      </div>

      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect label="Staff" value={filters.userId} onChange={(v) => patch({ userId: v })} options={settings.staff} />
        <FilterSelect label="Record type" value={filters.entityType} onChange={(v) => patch({ entityType: v })} options={ENTITY_TYPES} />
        <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
          Clear filters
        </button>
        {data && <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink-muted)' }}>{data.total} activity records</div>}
      </div>

      <div className="panel table-scroll">
        {!data ? (
          <div className="empty-state">Loading…</div>
        ) : data.rows.length === 0 ? (
          <div className="empty-state">No activity matches these filters yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date / time</th>
                <th>User</th>
                <th>Action</th>
                <th>Record type</th>
                <th>Record</th>
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{(r.at || '').replace('T', ' ')}</td>
                  <td>{r.by}</td>
                  <td>
                    {r.action === 'created' ? (
                      <span className="badge badge-success">Created</span>
                    ) : (
                      <span className="badge badge-info">Edited</span>
                    )}
                  </td>
                  <td>{r.entityTypeLabel}</td>
                  <td>{r.record}</td>
                  <td style={{ fontSize: 12 }}>{formatAuditChanges(r.changes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
