import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

// Settings -> Data health. Read-only: lists existing records affected by
// each known data issue (see server/src/services/dataHealth.js), so any fix
// can be judged against real data before it's built. Nothing on this page
// changes, links or recalculates anything.

const LABELS = {
  jobNumber: 'Job Number',
  saleJobNumber: 'Sale Job Number',
  linkedJobNumber: 'Linked job',
  visitDate: 'Visit date',
  saleDateLogged: 'Sale date logged',
  technician: 'Technician',
  jobTechnician: 'Job technician',
  saleCreditedTechnician: 'Sale credited to',
  creditedTechnician: 'Credited technician',
  invoiceNumber: 'Invoice',
  invoiceDate: 'Invoice date',
  saleValue: 'Value ex GST',
  upsellValue: 'Upsell value',
  saleStatus: 'Converting sale',
  lead: 'Lead',
  saleMade: 'Sale made',
  storedKnockback: 'Stored knock-back',
  expectedKnockback: 'Should be',
  tradeDiffers: 'Trade differs',
  jobTypeDiffers: 'Job type differs',
  dateLogged: 'Date logged',
  activeJobs: 'Active jobs',
  visits: 'Visits',
  inspectionSheet: 'Inspection sheet',
  optionSheet: 'Option sheet',
  sales: 'Sales',
  entries: 'Entries',
  callDate: 'Call date',
  leadSource: 'Lead source',
  handledBy: 'Handled by',
  bookedLeadCalls: 'Booked Lead calls',
  calls: 'Calls',
};

function cell(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'saleValue' || key === 'upsellValue') return `$${Number(value).toLocaleString('en-AU', { maximumFractionDigits: 2 })}`;
  return String(value);
}

function Check({ c }) {
  const [open, setOpen] = useState(false);
  const clean = c.count === 0;
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span className={`badge ${clean ? 'badge-success' : 'badge-warn'}`}>{clean ? 'None found' : `${c.count} found`}</span>
        <div style={{ fontSize: 14, fontWeight: 600, flex: '1 1 300px' }}>{c.title}</div>
        <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
          {c.finding === 'Lead rules' ? 'From the Lead Qualification change' : `Bug test finding ${c.finding}`}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginTop: 6 }}>{c.explanation}</div>
      {!clean && (
        <>
          {c.effect && <div style={{ fontSize: 12.5, marginTop: 6 }}>{c.effect}</div>}
          <button className="btn btn-sm" type="button" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide records' : `Show ${c.count} record${c.count === 1 ? '' : 's'}`}
          </button>
          {open && (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>{c.columns.map((k) => <th key={k}>{LABELS[k] || k}</th>)}</tr>
                </thead>
                <tbody>
                  {c.rows.map((r, i) => (
                    <tr key={i}>{c.columns.map((k) => <td key={k}>{cell(k, r[k])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function DataHealth() {
  const [state, setState] = useState({ loading: true });

  function run() {
    setState({ loading: true });
    api.dataHealth
      .run()
      .then((data) => setState({ data }))
      .catch((err) => setState({ error: err.message || 'The checks could not be run.' }));
  }
  useEffect(run, []);

  const found = state.data?.checks.filter((c) => c.count > 0).length ?? 0;
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Read-only. Lists existing records affected by each known data issue, so any fix can be checked against real data before it's
        built. Running these checks never changes, links or recalculates anything.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <button className="btn" type="button" onClick={run} disabled={state.loading}>
          {state.loading ? 'Checking…' : 'Run checks again'}
        </button>
        {state.data && (
          <span style={{ fontSize: 12.5 }}>
            {found === 0 ? 'No issues found.' : `${found} of ${state.data.checks.length} checks found records.`} Checked{' '}
            {new Date(state.data.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })}.
          </span>
        )}
      </div>
      {state.error && <div className="notice error panel">{state.error}</div>}
      {state.data?.checks.map((c) => <Check key={c.id} c={c} />)}
    </div>
  );
}
