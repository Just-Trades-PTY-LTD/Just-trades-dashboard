import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs, FilterSelect } from '../../components/Fields.jsx';

// Needs Attention (Stage 4): records that need a staff action, worked out live
// from existing records. Nothing here changes a record — "Open" goes to the
// record's normal screen. "Reviewed — leave as is" (reason required) moves an
// item to Closed, where Admin and Staff can reopen it. Office accounts only.

const dateLabel = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
};
const ageLabel = (n) => (n === null || n === undefined ? '' : n <= 0 ? 'today' : `${n} day${n === 1 ? '' : 's'}`);

function DismissForm({ item, onDone, onCancel }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.needsAttention.dismiss(item.key, reason);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <div style={{ flexBasis: '100%', marginTop: 6 }} data-testid="dismiss-form">
      <label style={{ fontSize: 12, fontWeight: 600 }}>Why should this be left as it is? (required)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        style={{ width: '100%', marginTop: 4, padding: 6, border: '1px solid var(--border)', borderRadius: 5, font: 'inherit' }}
        placeholder="e.g. Customer cancelled by text — no call was logged"
      />
      {error && <div className="notice error" style={{ marginTop: 4 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="btn btn-sm btn-primary" type="button" disabled={busy || !reason.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Mark reviewed — leave as is'}
        </button>
        <button className="btn btn-sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ActiveItems({ openRecord, onCountChange }) {
  const [scope, setScope] = useState('all');
  const [group, setGroup] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [dismissing, setDismissing] = useState(null);
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    setError('');
    api.needsAttention
      .list({ mine: scope === 'mine' ? '1' : undefined })
      .then((d) => {
        setData(d);
        if (scope === 'all') onCountChange?.(d.total);
      })
      .catch((err) => setError(err.message));
  }, [scope, onCountChange]);
  useEffect(load, [load]);

  if (error) return <div className="notice error">{error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;
  const groups = data.groups.filter((g) => g.items.length && (!group || g.id === group));
  return (
    <div>
      <div className="panel" style={{ padding: 14, marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} data-unsaved-ignore>
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Show</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} data-testid="na-scope">
            <option value="all">All</option>
            <option value="mine">Mine</option>
          </select>
        </div>
        <FilterSelect label="Type" value={group} onChange={setGroup} options={data.groups.map((g) => ({ id: g.id, name: `${g.title} (${g.items.length})` }))} />
        <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink-muted)' }}>
          {data.total} item{data.total === 1 ? '' : 's'} need{data.total === 1 ? 's' : ''} attention{scope === 'mine' ? ' (yours)' : ''}
        </div>
      </div>
      {message && (
        <div className="notice panel" role="status" style={{ marginBottom: 10 }}>
          {message}
        </div>
      )}
      {data.overdueFollowUps > 0 && (
        <div className="panel" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }} data-testid="na-followups">
          <strong>{data.overdueFollowUps}</strong> overdue follow-up{data.overdueFollowUps === 1 ? '' : 's'}
          <button className="btn btn-sm" type="button" style={{ marginLeft: 'auto' }} onClick={() => openRecord({ module: 'followups' })}>
            Open Follow-ups
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <div className="panel empty-state">Nothing needs attention{scope === 'mine' ? ' on your records' : ''}.</div>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="panel" style={{ padding: 14, marginBottom: 12 }} data-testid={`na-group-${g.id}`}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {g.title} <span className="badge badge-warn">{g.items.length}</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginBottom: 6 }}>
              {g.waitDays ? `Shown after ${g.waitDays} days.` : 'Shown straight away.'}
              {g.from ? ' Records from 1 October 2026 onwards (earlier ones are in Data Health).' : ''}
            </div>
            {g.items.map((i) => (
              <div key={i.key} className="list-row" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }} data-testid="na-item">
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ fontSize: 13.5 }}>
                    {i.jobNumber ? <strong className="mono">JN {i.jobNumber}</strong> : <strong>No Job Number</strong>} · {dateLabel(i.date)}
                    {i.ageDays !== null && i.ageDays !== undefined && <span style={{ color: 'var(--ink-muted)' }}> · {ageLabel(i.ageDays)}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                    {i.title}
                    {i.detail ? ` · ${i.detail}` : ''}
                    {i.staff ? ` · ${i.staff}` : ''}
                  </div>
                </div>
                <button className="btn btn-sm btn-primary" type="button" onClick={() => openRecord(i.open)} title={i.action}>
                  {i.action}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => setDismissing(dismissing === i.key ? null : i.key)}>
                  Reviewed — leave as is…
                </button>
                {dismissing === i.key && (
                  <DismissForm
                    item={i}
                    onCancel={() => setDismissing(null)}
                    onDone={() => {
                      setDismissing(null);
                      setMessage('Moved to Closed. It stays there until someone reopens it.');
                      load();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function ClosedItems({ openRecord, onChange }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(() => {
    api.needsAttention
      .closed()
      .then((d) => setItems(d.items))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);
  async function reopen(item) {
    if (!window.confirm(`Reopen this item?\n\n${item.label}\n\nIt goes back on the active list if the record still needs attention.`)) return;
    try {
      await api.needsAttention.reopen(item.key);
      setMessage(item.stillApplies ? 'Reopened — it is back on the active list.' : 'Reopened. Its record no longer has the problem, so it won\'t show on the active list.');
      load();
      onChange?.();
    } catch (err) {
      setError(err.message);
    }
  }
  if (error) return <div className="notice error">{error}</div>;
  if (!items) return <div className="empty-state">Loading…</div>;
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
        Items marked "Reviewed — leave as is". They stay here, even if their record changes, until someone reopens them.
      </div>
      {message && (
        <div className="notice panel" role="status" style={{ marginBottom: 10 }}>
          {message}
        </div>
      )}
      {items.length === 0 ? (
        <div className="panel empty-state">Nothing has been closed.</div>
      ) : (
        <div className="panel" style={{ padding: 14 }}>
          {items.map((i) => (
            <div key={i.key} className="list-row" style={{ flexWrap: 'wrap', gap: 8 }} data-testid="na-closed-item">
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ fontSize: 13.5 }}>{i.label}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                  Reason: {i.reason} · Closed by {i.dismissedBy} · {i.dismissedAt}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>{i.stillApplies ? 'The record still has this problem.' : 'The record no longer has this problem.'}</div>
              </div>
              {i.open && (
                <button className="btn btn-sm" type="button" onClick={() => openRecord(i.open)}>
                  Open record
                </button>
              )}
              <button className="btn btn-sm" type="button" onClick={() => reopen(i)}>
                Reopen…
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NeedsAttentionPage({ openRecord, onCountChange }) {
  const [sub, setSub] = useState('active');
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['active', 'Needs attention'],
          ['closed', 'Closed'],
        ]}
      />
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', margin: '10px 0 12px' }}>
        Records that need a staff action. Nothing here changes a record — Open takes you to the record to fix it, and the item disappears
        once it's fixed.
      </div>
      {sub === 'active' ? (
        <ActiveItems key={refreshKey} openRecord={openRecord} onCountChange={onCountChange} />
      ) : (
        <ClosedItems openRecord={openRecord} onChange={() => setRefreshKey((k) => k + 1)} />
      )}
    </div>
  );
}
