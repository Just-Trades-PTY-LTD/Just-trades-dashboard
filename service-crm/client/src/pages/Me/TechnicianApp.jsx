import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { currentAdelaideWeek, DATE_RANGE_PRESETS, matchDateRangePreset, money } from '../../lib/dates.js';
import { DateField, FilterSelect, DateRangePresetSelect } from '../../components/Fields.jsx';
import logo from '../../assets/logo.png';

// The whole app for a Technician account: My Performance, My Reviews and My
// account only. Every figure and record comes from the /api/me routes, which
// the server always scopes to the technician linked to this account — this
// screen never sends a technician of its own, and the server ignores one if
// sent. View-only: there is nothing here that adds, edits or exports.

const TABS = [
  ['performance', 'My Performance'],
  ['reviews', 'My Reviews'],
  ['account', 'My account'],
];

export default function TechnicianApp({ user, logout }) {
  const [tab, setTab] = useState('performance');
  return (
    <div className="app-shell">
      <div className="app-header">
        <img src={logo} alt="Just Trades" className="app-logo" />
        <div className="app-header-right">
          <span>
            {user.name} · Technician{user.technicianName ? ` (${user.technicianName})` : ''}
          </span>
          <button className="btn btn-sm" onClick={logout} type="button">
            Sign out
          </button>
        </div>
      </div>
      <div className="app-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} type="button">
            {label}
          </button>
        ))}
      </div>
      {!user.technicianActive && tab !== 'account' ? (
        <div className="panel empty-state">Your technician record is inactive or missing, so there's nothing to show. Please contact an admin.</div>
      ) : tab === 'performance' ? (
        <MyPerformance />
      ) : tab === 'reviews' ? (
        <MyReviews />
      ) : (
        <MyAccount user={user} />
      )}
    </div>
  );
}

function useMyFilters() {
  const [filters, setFilters] = useState(() => ({ ...currentAdelaideWeek(), tradeId: '', jobTypeId: '' }));
  return [filters, (p) => setFilters((f) => ({ ...f, ...p }))];
}

function DateFilters({ filters, patch }) {
  return (
    <>
      <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
      <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
      <DateRangePresetSelect
        value={matchDateRangePreset(filters.from, filters.to)}
        onChange={(id) => {
          const preset = DATE_RANGE_PRESETS.find((p) => p.id === id);
          if (preset?.range) patch(preset.range());
        }}
        options={DATE_RANGE_PRESETS}
      />
    </>
  );
}

const rate = (v) => (v == null ? '—' : `${v}%`);

// Same figures, same order and the same definitions as this technician's own
// row in the admin "By technician" table. `open` = clickable (has records).
const FIGURES = [
  ['jobsAttended', 'Total Jobs', (v) => v, true],
  ['qualifiedJobs', 'Qualified Jobs', (v) => v, true],
  ['sales', 'Sales (invoices)', (v) => v, true],
  ['convertedLaterCredits', 'Converted Later', (v) => v, true],
  ['actualKnockbacks', 'Actual Knockbacks', (v) => v, true],
  ['adjustedKnockbacks', 'Adjusted Knockbacks', (v) => v, false, 'Actual Knockbacks minus Converted Later.'],
  ['bonusConversionRate', 'Conversion %', (v) => `${(v ?? 0).toFixed(2)}%`, false, '(Qualified Jobs − Adjusted Knockbacks) ÷ Qualified Jobs.'],
  ['totalSaleExGst', 'Total Sale Value (ex GST)', money, true, 'Your sales plus any upsells credited to you.'],
  ['avgSaleExGst', 'Average Sale Value (ex GST)', money, true, 'Your original sales (not upsells) ÷ your Qualified Jobs.'],
  ['callBacks', 'Call Backs', (v) => v, true],
  ['pendingCancellations', 'Pending Cancellations', (v) => v, true],
  ['inspectionRate', 'Inspection Sheet %', rate, true],
  ['optionRate', 'Option Sheet %', rate, true],
];

function MyPerformance() {
  const [filters, patch] = useMyFilters();
  const [trades, setTrades] = useState([]);
  const [data, setData] = useState(null);
  const [reasons, setReasons] = useState(null);
  const [error, setError] = useState('');
  const [records, setRecords] = useState(null);

  useEffect(() => {
    api.me.filters().then((r) => setTrades(r.trades)).catch(() => {});
  }, []);
  useEffect(() => {
    setError('');
    Promise.all([api.me.performance(filters), api.me.knockbackReasons(filters)])
      .then(([p, k]) => {
        setData(p);
        setReasons(k);
      })
      .catch((err) => setError(err.message));
  }, [filters]);

  const jobTypes = trades.find((t) => String(t.id) === String(filters.tradeId))?.jobTypes || [];
  function open(field, label, extra = {}) {
    setRecords({ label, loading: true });
    api.me
      .performanceDrilldown({ ...filters, field, ...extra })
      .then((d) => setRecords({ ...d, label }))
      .catch((err) => setRecords({ label, error: err.message }));
  }

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <DateFilters filters={filters} patch={patch} />
        <FilterSelect label="Trade" value={filters.tradeId} onChange={(v) => patch({ tradeId: v, jobTypeId: '' })} options={trades} />
        <FilterSelect label="Job type" value={filters.jobTypeId} onChange={(v) => patch({ jobTypeId: v })} options={jobTypes} />
      </div>
      {error && <div className="notice error panel">{error}</div>}
      {data && (
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{data.technicianName}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
            Your own figures only, worked out exactly as in the company report. Click a figure to see its records.
          </div>
          <table className="data-table" data-testid="my-performance">
            <tbody>
              {FIGURES.map(([key, label, render, clickable, help]) => (
                <tr key={key}>
                  <th style={{ textAlign: 'left', width: 260 }} title={help}>
                    {label}
                  </th>
                  <td
                    className={clickable ? 'clickable-stat' : undefined}
                    onClick={clickable ? () => open(key, label) : undefined}
                    title={clickable ? `View your records behind ${label}` : help}
                  >
                    {render(data.figures[key])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reasons && (
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>My Knockback Reasons</div>
          {reasons.total === 0 ? (
            <div className="empty-state">No knockbacks in this range.</div>
          ) : (
            <table className="data-table" data-testid="my-knockback-reasons">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>Knockbacks</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {reasons.byReason.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td className="clickable-stat" onClick={() => open('knockbackByReason', `Knockbacks — ${r.name}`, { category: r.name })}>
                      {r.count}
                    </td>
                    <td>{r.percent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {records && <RecordsModal records={records} onClose={() => setRecords(null)} />}
    </div>
  );
}

// Read-only list of the technician's own records behind one figure.
function RecordsModal({ records, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drilldown-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel drilldown-panel" role="dialog" aria-label={records.label}>
        <div className="drilldown-header">
          <div>
            <h3 style={{ margin: 0 }}>{records.label}</h3>
            {!records.loading && !records.error && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
                {records.count} record{records.count === 1 ? '' : 's'}
              </div>
            )}
          </div>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            Close ✕
          </button>
        </div>
        <div className="drilldown-body">
          {records.loading ? (
            <div className="empty-state">Loading…</div>
          ) : records.error ? (
            <div className="empty-state">{records.error}</div>
          ) : records.rows.length === 0 ? (
            <div className="empty-state">No records.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table" data-testid="my-records">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry type</th>
                    <th>JN</th>
                    <th>Trade / job type</th>
                    <th>Suburb</th>
                    <th>Outcome</th>
                    <th>Invoice</th>
                    <th>Value ex GST</th>
                  </tr>
                </thead>
                <tbody>
                  {records.rows.map((r) => (
                    <tr key={`${r.kind}:${r.id}`}>
                      <td className="mono">{r.dateShown || r.visitDate || '—'}</td>
                      <td>{r.entryLabel}</td>
                      <td className="mono">{r.jobNumber || '—'}</td>
                      <td>
                        {r.tradeName || '—'}
                        {r.jobTypeName ? ` — ${r.jobTypeName}` : ''}
                      </td>
                      <td>{r.suburb || '—'}</td>
                      <td>{outcome(r)}</td>
                      <td className="mono">{r.invoiceNumber || '—'}</td>
                      <td>{r.saleValueExGst ? money(r.saleValueExGst) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function outcome(r) {
  if (r.kind === 'new_job_no_sale') {
    if (r.lead === 'Not Qualified') return 'Not qualified';
    return r.convertedLater ? 'Converted later' : `Knock back${r.knockbackReasonName ? `: ${r.knockbackReasonName}` : ''}`;
  }
  if (r.kind === 'call_back' || r.kind === 'pending_cancellation') return r.reasonName || '—';
  return r.workCompletion || 'Sale';
}

function MyReviews() {
  const [filters, patch] = useMyFilters();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    api.me
      .reviews({ from: filters.from, to: filters.to })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [filters.from, filters.to]);
  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <DateFilters filters={filters} patch={patch} />
      </div>
      {error && <div className="notice error panel">{error}</div>}
      {data && (
        <>
          <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>My review totals</div>
            <table className="data-table" data-testid="my-review-totals">
              <tbody>
                <tr><th style={{ textAlign: 'left', width: 220 }}>Total reviews</th><td>{data.totals.total}</td></tr>
                <tr><th style={{ textAlign: 'left' }}>Positive (4–5★)</th><td>{data.totals.positive}</td></tr>
                <tr><th style={{ textAlign: 'left' }}>Neutral (3★)</th><td>{data.totals.neutral}</td></tr>
                <tr><th style={{ textAlign: 'left' }}>Negative (1–2★)</th><td>{data.totals.negative}</td></tr>
                <tr><th style={{ textAlign: 'left' }}>Average rating</th><td>{data.totals.averageRating ?? '—'}</td></tr>
                {data.totals.byStars.map((b) => (
                  <tr key={b.stars}>
                    <th style={{ textAlign: 'left' }}>{'★'.repeat(b.stars)}</th>
                    <td>{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>My reviews</div>
            {data.rows.length === 0 ? (
              <div className="empty-state">No reviews credited to you in this range.</div>
            ) : (
              <table className="data-table" data-testid="my-reviews">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Rating</th>
                    <th>Status</th>
                    <th>Review</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.reviewDate}</td>
                      <td>{'★'.repeat(r.rating)}</td>
                      <td>{r.classification}</td>
                      <td style={{ maxWidth: 460 }}>{r.notes || '—'}</td>
                      <td>{r.shared && <span className="badge badge-info">Shared review</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MyAccount({ user }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [message, setMessage] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setMessage({ error: true, text: 'The new passwords don’t match.' });
    try {
      await api.auth.changePassword(form.currentPassword, form.newPassword);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setMessage({ text: 'Password changed.' });
    } catch (err) {
      setMessage({ error: true, text: err.message });
    }
  }
  return (
    <form className="panel" style={{ padding: 18, maxWidth: 520 }} onSubmit={submit}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{user.name}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 14 }}>{user.email}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>Change password</div>
      {message && <div className={`notice ${message.error ? 'error' : ''}`} style={{ marginBottom: 10 }}>{message.text}</div>}
      {[
        ['currentPassword', 'Current password'],
        ['newPassword', 'New password (min 8 characters)'],
        ['confirm', 'Confirm new password'],
      ].map(([key, label]) => (
        <div className="field" key={key} style={{ marginBottom: 10 }}>
          <label>{label}</label>
          <input type="password" value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} required minLength={key === 'currentPassword' ? 1 : 8} />
        </div>
      ))}
      <button className="btn btn-primary" type="submit">
        Change password
      </button>
    </form>
  );
}
