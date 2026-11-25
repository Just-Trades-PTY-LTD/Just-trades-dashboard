import { useState } from 'react';
import { api } from '../../lib/api.js';

// Missing entries check — READ-ONLY TEST (Admin only). Reads AroFlo (GET
// only) for Job Numbers with labour by an active CRM technician in the
// range, removes duplicate Job Numbers, and compares them with the CRM.
// Nothing is saved or changed anywhere. Also shows how AroFlo answered, so
// the real check can be built the cheapest way.

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function presets() {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const lastMonday = new Date(monday);
  lastMonday.setDate(monday.getDate() - 7);
  const lastSunday = new Date(monday);
  lastSunday.setDate(monday.getDate() - 1);
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  return [
    ['Yesterday', iso(y), iso(y)],
    ['Today', iso(today), iso(today)],
    ['This week', iso(monday), iso(today)],
    ['Last week', iso(lastMonday), iso(lastSunday)],
    ['This month', iso(firstOfMonth), iso(today)],
  ];
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '—';
};

function JobRows({ rows, showMatch }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table" style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th>JN</th>
            <th>AroFlo status</th>
            <th>Job type</th>
            <th>Suburb</th>
            <th>Technician(s)</th>
            <th>Labour days in range</th>
            {showMatch && <th>Accounted for as</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.jobNumber}>
              <td className="mono">{j.jobNumber}</td>
              <td>{j.status || '—'}</td>
              <td>{j.taskType || '—'}</td>
              <td>{j.suburb || '—'}</td>
              <td>{j.technicians.join(', ')}</td>
              <td>{j.dates.map(short).join(', ')}</td>
              {showMatch && <td>{j.accountedFor.join(', ')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MissingEntriesTest() {
  const p = presets();
  const [from, setFrom] = useState(p[0][1]);
  const [to, setTo] = useState(p[0][2]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [showAccounted, setShowAccounted] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    setData(null);
    try {
      setData(await api.arofloTest.missingEntries(from, to));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const missing = data ? data.jobs.filter((j) => !j.accountedFor.length) : [];
  const accounted = data ? data.jobs.filter((j) => j.accountedFor.length) : [];
  const m = data?.method;

  return (
    <div data-testid="missing-entries-test">
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>Missing entries check — read-only test (Admin only)</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', margin: '4px 0 10px' }}>
          Lists AroFlo Job Numbers where an active CRM technician logged labour in the dates chosen, once per Job Number, and shows whether
          each is already in the CRM (New Job entry, Call Back, or an approved quote's New Job Number). Read-only: it only reads AroFlo and
          the CRM — nothing is saved or changed. Up to 31 days; it may take a minute and uses AroFlo requests (shown below).
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {p.map(([label, f, t]) => (
            <button
              key={label}
              className={`btn btn-sm${from === f && to === t ? ' btn-primary' : ''}`}
              type="button"
              onClick={() => {
                setFrom(f);
                setTo(t);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="me-from" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="me-to" />
          </div>
          <button className="btn btn-primary" type="button" onClick={run} disabled={busy || !from || !to} data-testid="me-run">
            {busy ? 'Checking AroFlo…' : 'Run check'}
          </button>
        </div>
        {error && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {data && (
        <>
          <div className="panel" style={{ padding: 14, marginBottom: 12 }} data-testid="me-summary">
            <strong>{data.summary.jobNumbers}</strong> Job Number{data.summary.jobNumbers === 1 ? '' : 's'} with technician labour ·{' '}
            <strong>{data.summary.accountedFor}</strong> accounted for · <strong style={{ color: data.summary.missing ? 'var(--alert)' : undefined }}>{data.summary.missing}</strong>{' '}
            not in the CRM ({short(data.from)}–{short(data.to)})
            {(m.labourCapped || m.pagesCapped) && (
              <div className="notice error" style={{ marginTop: 8 }}>
                Stopped early at the test's safety limit — results may be incomplete. Try a shorter range.
              </div>
            )}
          </div>

          <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Not in the CRM ({missing.length})</div>
            {missing.length ? <JobRows rows={missing} /> : <div className="empty-state">Every Job Number found is accounted for.</div>}
          </div>

          <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
            <button className="link-btn" type="button" onClick={() => setShowAccounted((v) => !v)}>
              {showAccounted ? 'Hide' : 'Show'} accounted for ({accounted.length})
            </button>
            {showAccounted && <JobRows rows={accounted} showMatch />}
          </div>

          {data.unmatchedLabourNames.length > 0 && (
            <div className="panel" style={{ padding: 14, marginBottom: 12, fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>AroFlo staff who logged labour but aren't an active CRM technician (left out)</div>
              {data.unmatchedLabourNames.map((u) => `${u.name} (${u.entries})`).join(' · ')}
            </div>
          )}

          <div className="panel" style={{ padding: 14, fontSize: 12.5 }} data-testid="me-method">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>How AroFlo answered (for building the real check)</div>
            <div>
              {m.totalRequests} AroFlo requests · {m.seconds}s · {m.tasksRead} newest jobs read ({m.taskPages} page{m.taskPages === 1 ? '' : 's'}, look-back{' '}
              {m.lookbackDays} days) · {m.candidateJobs} jobs checked for labour ({m.labourRequests} requests
              {m.labourUnavailable ? `, ${m.labourUnavailable} unavailable` : ''})
            </div>
            <table className="table" style={{ width: '100%', marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Date filter tried</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {m.dateFilterTests.map((t) => (
                  <tr key={t.label}>
                    <td className="mono">{t.label}</td>
                    <td>
                      {!t.available
                        ? `Not accepted (HTTP ${t.status || '—'})${t.aroflo ? ` — ${t.aroflo}` : ''}`
                        : `${t.filterHonoured ? 'Filter works' : 'Filter ignored or no dated items'} · ${t.returned} returned${t.reportedCount !== null ? ` of ${t.reportedCount}` : ''} · ${t.insideRange}/${t.datedItems} in range${t.earliest ? ` (${t.earliest} to ${t.latest})` : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
