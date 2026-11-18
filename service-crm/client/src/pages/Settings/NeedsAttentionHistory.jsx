import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

// Needs Attention: every "Reviewed — leave as is" and every reopening, with
// who, when and the reason. Read-only.
export default function NeedsAttentionHistory() {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    api.needsAttention
      .history()
      .then((d) => setEvents(d.events))
      .catch(() => setEvents([]));
  }, []);
  return (
    <div style={{ marginTop: 24 }} data-testid="needs-attention-history">
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Needs Attention — reviewed and reopened</div>
      <div className="panel table-scroll">
        {!events ? (
          <div className="empty-state">Loading…</div>
        ) : events.length === 0 ? (
          <div className="empty-state">No Needs Attention items have been reviewed or reopened yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date / time</th>
                <th>By</th>
                <th>Action</th>
                <th>Item</th>
                <th>Reason given</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, idx) => (
                <tr key={idx}>
                  <td className="mono">{e.atLocal}</td>
                  <td>{e.by}</td>
                  <td>
                    <span className="badge badge-info">{e.action === 'dismissed' ? 'Reviewed — left as is' : 'Reopened'}</span>
                  </td>
                  <td style={{ fontSize: 12 }}>{e.label}</td>
                  <td style={{ fontSize: 12 }}>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
