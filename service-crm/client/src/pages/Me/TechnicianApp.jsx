import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { currentAdelaideWeek, DATE_RANGE_PRESETS, matchDateRangePreset, money } from '../../lib/dates.js';
import { DateField, DateRangePresetSelect, FilterSelect } from '../../components/Fields.jsx';
import { SettingsProvider } from '../../lib/SettingsContext.jsx';
import { ReportAccessContext } from '../../lib/reportAccess.js';
import TechReport from '../Reports/TechReport.jsx';
import logo from '../../assets/logo.png';

// The whole app for a Technician account: the team Technician & Sales
// Report (read-only, same layout and statistics Staff see), My Reviews and
// My account. The report reads only the statistics-only /api/me routes; the
// only records a technician can open are their OWN, from their own By
// technician figures, and the server always scopes those to the technician
// linked to this account. Nothing here adds, edits or exports.

const TABS = [
  ['report', 'Technician & Sales Report'],
  ['reviews', 'Reviews'],
  ['account', 'My Account'],
];

// Stable reference (SettingsProvider reloads when it changes).
const loadTechnicianBundle = () => api.me.reportSettings();

const FIELD_LABELS = {
  jobsAttended: 'Total Jobs',
  qualifiedJobs: 'Qualified Jobs',
  sales: 'Sales (invoices)',
  convertedLaterCredits: 'Converted Later',
  actualKnockbacks: 'Actual Knockbacks',
  totalSaleExGst: 'Value (ex GST)',
  avgSaleExGst: 'Average Sale',
  callBacks: 'Call Backs',
  pendingCancellations: 'Pending Cancellations',
  inspectionRate: 'Inspection Sheet %',
  optionRate: 'Option Sheet %',
};

export default function TechnicianApp({ user, logout }) {
  const [tab, setTab] = useState('report');
  const [records, setRecords] = useState(null);

  function openOwnRecords(field, filters) {
    const label =
      field === 'knockbackByReason'
        ? `${user.technicianName} — Knockbacks: ${filters.category}`
        : `${user.technicianName} — ${FIELD_LABELS[field] || field}`;
    setRecords({ label, loading: true });
    api.me
      .performanceDrilldown({ ...filters, field })
      .then((d) => setRecords({ ...d, label }))
      .catch((err) => setRecords({ label, error: err.message }));
  }
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
      ) : tab === 'report' ? (
        <SettingsProvider loadBundle={loadTechnicianBundle}>
          <ReportAccessContext.Provider value={{ technician: true, ownTechnicianName: user.technicianName, ownTechnicianId: user.technicianId, openOwnRecords }}>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
              Read-only team report. Only your own figures in the By technician table open records (your own).
            </div>
            <TechReport drilldown={null} setDrilldown={() => {}} />
          </ReportAccessContext.Provider>
          {records && <RecordsModal records={records} onClose={() => setRecords(null)} />}
        </SettingsProvider>
      ) : tab === 'reviews' ? (
        <TeamReviews />
      ) : (
        <MyAccount user={user} />
      )}
    </div>
  );
}

function useMyFilters() {
  const [filters, setFilters] = useState(() => ({ ...currentAdelaideWeek() }));
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

const RATING_OPTIONS = ['5', '4', '3', '2', '1'].map((v) => ({ id: v, name: `${v} star${v === '1' ? '' : 's'}` }));
const CLASS_OPTIONS = ['Positive', 'Neutral', 'Negative'].map((v) => ({ id: v, name: v }));

// The team's reviews, read-only: totals, star breakdown, per-technician
// breakdown and every review with the technicians credited to it.
function TeamReviews() {
  const [filters, patch] = useMyFilters();
  const [technicians, setTechnicians] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.me
      .reportSettings()
      .then((r) => setTechnicians(r.technicians.map((t) => ({ id: t.id, name: t.active ? t.name : `${t.name} (inactive)` }))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    setError('');
    api.me
      .reviews(filters)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [filters]);
  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <DateFilters filters={filters} patch={patch} />
        <FilterSelect label="Technician" value={filters.technicianId || ''} onChange={(v) => patch({ technicianId: v })} options={technicians} />
        <FilterSelect label="Star rating" value={filters.rating || ''} onChange={(v) => patch({ rating: v, ratingClass: '' })} options={RATING_OPTIONS} />
        <FilterSelect label="Classification" value={filters.ratingClass || ''} onChange={(v) => patch({ ratingClass: v, rating: '' })} options={CLASS_OPTIONS} />
      </div>
      {error && <div className="notice error panel">{error}</div>}
      {data && (
        <>
          <div className="grid-charts" style={{ marginBottom: 14 }}>
            <div className="panel" style={{ padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Team review totals</div>
              <table className="data-table" data-testid="team-review-totals">
                <tbody>
                  <tr><th style={{ textAlign: 'left', width: 200 }}>Total reviews</th><td>{data.totals.total}</td></tr>
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
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Reviews by technician</div>
              {data.byTechnician.length === 0 ? (
                <div className="empty-state">No reviews in this range.</div>
              ) : (
                <table className="data-table" data-testid="team-reviews-by-technician">
                  <thead>
                    <tr>
                      <th>Technician</th>
                      <th>Reviews</th>
                      <th>Positive</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTechnician.map((t) => (
                      <tr key={t.name}>
                        <td>{t.name}</td>
                        <td>{t.total}</td>
                        <td>{t.positive}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="panel" style={{ padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Reviews</div>
            {data.rows.length === 0 ? (
              <div className="empty-state">No reviews in this range.</div>
            ) : (
              <table className="data-table" data-testid="team-reviews">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Rating</th>
                    <th>Status</th>
                    <th>Technician(s)</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.reviewDate}</td>
                      <td>{'★'.repeat(r.rating)}</td>
                      <td>{r.classification}</td>
                      <td>
                        {r.technicians.join(', ') || '—'}
                        {r.technicians.length > 1 && (
                          <>
                            {' '}
                            <span className="badge badge-info">Shared review</span>
                          </>
                        )}
                      </td>
                      <td style={{ maxWidth: 420 }}>{r.notes || '—'}</td>
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
