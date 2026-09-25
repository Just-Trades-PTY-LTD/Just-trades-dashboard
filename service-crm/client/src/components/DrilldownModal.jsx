import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import CallHistory from '../pages/Calls/CallHistory.jsx';
import LogCall from '../pages/Calls/LogCall.jsx';
import JobHistory from '../pages/TechSales/JobHistory.jsx';
import LogEntry from '../pages/TechSales/LogEntry.jsx';

// Opens as an overlay ON TOP of a report — the report page underneath is
// never unmounted, so its filters, its AdjustableSection layout and its
// scroll position are exactly as the user left them the moment this closes.
// `kind` picks which drill-down endpoint/history log/edit form to use;
// `params` is the exact metric/category/scope selector plus the report's own
// current filters (see server/src/services/reports.js for the full list).
export default function DrilldownModal({ kind, params, jumpToJN, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingRecord, setEditingRecord] = useState(null);
  const [notice, setNoticeState] = useState(null);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 5000);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = kind === 'calls' ? await api.reports.callsDrilldown(params) : await api.reports.techDrilldown(params);
      setData(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, JSON.stringify(params)]);

  // Prevent the page behind from scrolling while the overlay is open, and
  // let Escape close it — both undone on close/unmount, leaving the report
  // exactly as it was.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  async function handleSaved() {
    setEditingRecord(null);
    await load();
  }

  return (
    <div
      className="drilldown-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="panel drilldown-panel">
        <div className="drilldown-header">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{data ? data.label : 'Loading…'}</div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginTop: 2 }}>
              {data ? `${data.count} record${data.count === 1 ? '' : 's'} — matching this report's current filters` : ''}
            </div>
          </div>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            Close ✕
          </button>
        </div>

        {data?.outcomes && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 20px 14px' }}>
            {data.outcomes.map((o) => (
              <span key={o.label} className="badge badge-info">
                {o.label}: {o.count}
              </span>
            ))}
          </div>
        )}

        {notice && <div className={`notice panel ${notice.isError ? 'error' : ''}`} style={{ margin: '0 20px 14px' }}>{notice.message}</div>}

        <div className="drilldown-body">
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : editingRecord ? (
            kind === 'calls' ? (
              <LogCall editing={editingRecord} onSaved={handleSaved} onCancelEdit={() => setEditingRecord(null)} setNotice={setNotice} />
            ) : (
              <LogEntry editing={editingRecord} onSaved={handleSaved} onCancelEdit={() => setEditingRecord(null)} setNotice={setNotice} />
            )
          ) : kind === 'calls' ? (
            <CallHistory rows={data?.rows || []} loading={false} onEdit={setEditingRecord} onChanged={load} jumpToJN={jumpToJN} setNotice={setNotice} embedded />
          ) : (
            <JobHistory rows={data?.rows || []} loading={false} onEdit={setEditingRecord} onChanged={load} jumpToJN={jumpToJN} setNotice={setNotice} embedded />
          )}
        </div>
      </div>
    </div>
  );
}
