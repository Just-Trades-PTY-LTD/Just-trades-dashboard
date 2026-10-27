import { useState } from 'react';
import { api } from '../../lib/api.js';
import { TextField } from '../../components/Fields.jsx';

// Stage 1 only: a read-only lookup against AroFlo by job number, for
// checking what AroFlo actually returns before any of this is wired into
// the real New Job form. This page makes no CRM database changes and no
// AroFlo writes — it only ever calls GET /api/aroflo-test/lookup.
// One row per attempted candidate — shown as-is so a 404 ("not available")
// reads as a normal, useful result of the investigation, not an error.
function ProbeResultTable({ title, help, results }) {
  const list = Array.isArray(results) ? results : results ? [results] : [];
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {help && <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginBottom: 10 }}>{help}</div>}
      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>Nothing to try here for this task.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Tried</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.tried}>
                <td className="mono">{r.tried}</td>
                <td>
                  {r.available ? (
                    <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                      {JSON.stringify(r.data, null, 2)}
                    </pre>
                  ) : (
                    <div>
                      <span style={{ color: 'var(--ink-muted)' }}>
                        not available{r.status ? ` (HTTP ${r.status})` : ''} — {r.note}
                      </span>
                      {/* A 404 means the path doesn't exist — nothing further to show.
                          Anything else (e.g. a 400) means AroFlo recognised the endpoint
                          but rejected this request shape — its own response often says
                          exactly what parameter it wanted instead. */}
                      {r.status !== 404 && r.detail && (
                        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0' }}>
                          {JSON.stringify(r.detail, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// A business-unit-wide listing (not tied to one job) — "List all X" probes
// below all render through this same generic panel.
function ListingPanel({ title, state }) {
  if (!state) return null;
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {state.loading && <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>Loading…</div>}
      {!state.loading && state.error && <div style={{ color: 'var(--danger, #a3323a)' }}>{state.error}</div>}
      {!state.loading && !state.error && state.data && (
        state.data.available ? (
          <pre style={{ fontSize: 11.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(state.data.data, null, 2)}
          </pre>
        ) : (
          <div>
            <div style={{ color: 'var(--ink-muted)' }}>
              Not available on this account{state.data.status ? ` (HTTP ${state.data.status})` : ''} — {state.data.note}
            </div>
            {state.data.status !== 404 && state.data.detail && (
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0' }}>
                {JSON.stringify(state.data.detail, null, 2)}
              </pre>
            )}
          </div>
        )
      )}
    </div>
  );
}

export default function ArofloTest() {
  const [jn, setJn] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [taskTypes, setTaskTypes] = useState(null);
  const [locations, setLocations] = useState(null);
  const [users, setUsers] = useState(null);

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

  async function runListing(fn, setState) {
    setState({ loading: true, error: '', data: null });
    try {
      const data = await fn();
      setState({ loading: false, error: '', data });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Something went wrong.', data: null });
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

      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Business-unit-wide reference listings</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginBottom: 10 }}>
          Not tied to one job number — for checking whether a complete Task Types list or a structured Locations list exists on
          this account at all, ahead of building any future mapping table. A "not available" result just means that guess isn't
          how this account's API is set up.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn" type="button" onClick={() => runListing(api.arofloTest.taskTypes, setTaskTypes)}>
            List all Task Types
          </button>
          <button className="btn" type="button" onClick={() => runListing(api.arofloTest.locations, setLocations)}>
            List all Locations
          </button>
          <button className="btn" type="button" onClick={() => runListing(api.arofloTest.users, setUsers)}>
            List all Users
          </button>
        </div>
      </div>
      <ListingPanel title="Task Types" state={taskTypes} />
      <ListingPanel title="Locations" state={locations} />
      <ListingPanel title="Users" state={users} />

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

          {result.investigation && (
            <ProbeResultTable
              title="Who worked on / is booked for this job — labour, scheduled visits, assigned technicians"
              help="AroFlo's documented endpoints for this job: labour entries (time actually logged — who, which day, hours), every booked visit, and who's assigned, each with AroFlo's own user id. The summary's schedule fields above only ever hold the NEXT upcoming visit, which is why they're empty on a completed job. Pay and charge rates are removed before anything is shown. Read-only — nothing here is saved or applied anywhere."
              results={result.investigation.history}
            />
          )}
          {result.investigation?.suburbComparison && (
            <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Suburb — each AroFlo source side by side</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginBottom: 10 }}>
                The live New Job form currently uses only the first row. The other two are shown here purely to check, across real
                jobs, whether they'd be more reliable. Nothing here is applied anywhere.
              </div>
              <table className="data-table">
                <tbody>
                  {[
                    ['Matched from the job address text (used today)', result.investigation.suburbComparison.matchedFromAddressText],
                    ['Job’s own site location', result.investigation.suburbComparison.taskLocation],
                    ['Customer record’s address', result.investigation.suburbComparison.customerAddress],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ fontWeight: 600, width: 300 }}>{label}</td>
                      <td>
                        {!value ? '—' : typeof value === 'string' ? value : `${value.suburb}${value.postcode ? ` (${value.postcode})` : ''}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.investigation?.locationDetail && (
            <ProbeResultTable
              title="Additional investigation — structured location record (experimental)"
              help="Only tried when the task's own location object carries an id. Currently a no-op for every tested job, since `location` has come back null each time."
              results={result.investigation.locationDetail}
            />
          )}
          {result.investigation?.customFields && (
            <ProbeResultTable
              title="Additional investigation — custom fields e.g. Lead Source (experimental)"
              help="AroFlo's own task UI can show custom fields like 'Lead Source' and 'Occupant', but none have ever appeared in GET /tasks/{id}'s own response — these candidates try a few likely ways to request them instead. A 404 just means that guess isn't how this account's API is set up."
              results={result.investigation.customFields}
            />
          )}
          {result.investigation?.clientDetail && (
            <ProbeResultTable
              title="Additional investigation — client/customer record (experimental)"
              help="Only tried when the task's own `client` reference carries an id — if Lead Source is tracked once per customer rather than per job, this is where it would show up instead."
              results={result.investigation.clientDetail}
            />
          )}

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
