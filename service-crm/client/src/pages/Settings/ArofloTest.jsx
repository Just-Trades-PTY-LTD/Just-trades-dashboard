import { useState } from 'react';
import { api } from '../../lib/api.js';
import { TextField } from '../../components/Fields.jsx';

// Stage 1 only: a read-only lookup against AroFlo by job number, for
// checking what AroFlo actually returns before any of this is wired into
// the real New Job form. This page makes no CRM database changes and no
// AroFlo writes — it only ever calls GET /api/aroflo-test/lookup.
export default function ArofloTest() {
  const [jn, setJn] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function runLookup() {
    const value = jn.trim();
    if (!value) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await api.arofloTest.lookup(value);
      setResult(data);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Stage 1 test only — looks up one AroFlo task by job number and shows what comes back. This makes no changes to AroFlo
        and no changes to this CRM's data; it's purely read-only, for checking the integration before it's built into the real
        New Job form.
      </div>

      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <TextField label="AroFlo job number" value={jn} onChange={setJn} placeholder="e.g. 1377" />
        <button className="btn btn-primary" type="button" disabled={loading || !jn.trim()} onClick={runLookup}>
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && (
        <div className="panel" style={{ padding: 16, marginBottom: 16, color: 'var(--danger, #a3323a)' }}>
          {error}
        </div>
      )}

      {result && !result.found && (
        <div className="panel empty-state">{result.message}</div>
      )}

      {result && result.found && (
        <>
          <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Summary</div>
            <table className="data-table">
              <tbody>
                {Object.entries(result.summary)
                  .filter(([key]) => key !== 'invoices')
                  .map(([key, value]) => (
                    <tr key={key}>
                      <td style={{ fontWeight: 600, width: 180 }}>{key}</td>
                      <td>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              Invoices linked to this task ({result.summary.invoiceCount})
            </div>
            {result.summary.invoices.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>No invoices found for this task.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Date</th>
                    <th>Value ex GST</th>
                    <th>Status</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {result.summary.invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>{inv.invoiceNumber}</td>
                      <td className="mono">{(inv.invoicedDateTime || '').slice(0, 10)}</td>
                      <td>{inv.totalAmountEx}</td>
                      <td>{inv.status}</td>
                      <td>{inv.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel" style={{ padding: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Raw response</div>
            <pre style={{ fontSize: 11.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {JSON.stringify(result.raw, null, 2)}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
