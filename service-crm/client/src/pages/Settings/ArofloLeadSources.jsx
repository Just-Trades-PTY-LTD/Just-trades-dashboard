import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { SelectField } from '../../components/Fields.jsx';
import { normName } from '../../lib/arofloCallSuggest.js';

// Admin only: AroFlo customer Lead Source value -> CRM Lead Source, for the
// Calls & Contacts AroFlo lookup. Suggestions only ("Use this") — never
// applied on their own, never overwriting a staff choice, nothing saved
// until staff save the call. Saving here only affects future lookups; no
// saved call is changed. Values with no mapping and no exact-name match
// (e.g. Online Ad) stay reference only; a customer whose two AroFlo Lead
// Source fields disagree is left for staff.

// The mappings approved for this account (Nov 2026), by CRM name. Only fills
// the table below — nothing is saved until an admin presses Save.
const APPROVED = [
  ['Facebook/Socials', 'Social Media'],
  ['Meta', 'Social Media'],
  ['Flyer', 'Flyer/Magnet'],
  ['Hi Pages', 'HiPages'],
];

export default function ArofloLeadSources() {
  const settings = useSettings();
  const sources = settings.lists?.lead_source || [];
  const [rows, setRows] = useState([]);
  const [saved, setSaved] = useState([]);
  const [status, setStatus] = useState({ loading: true, error: '', message: '' });
  const [aroflo, setAroflo] = useState(null);

  async function load() {
    try {
      const { mappings } = await api.settings.arofloLeadSourceMappings();
      const asRows = mappings.map((m) => ({ arofloValue: m.arofloValue, leadSourceId: String(m.leadSourceId), broken: m.broken || null }));
      setRows(asRows);
      setSaved(asRows);
      setStatus({ loading: false, error: '', message: '' });
    } catch (err) {
      setStatus({ loading: false, error: err.message, message: '' });
    }
  }
  useEffect(() => {
    load();
  }, []);

  const strip = (list) => list.map(({ broken, ...r }) => r);
  const dirty = JSON.stringify(strip(rows)) !== JSON.stringify(strip(saved));
  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, broken: null } : r)));

  function fillApproved() {
    const missing = [];
    const next = [...rows];
    for (const [value, crmName] of APPROVED) {
      if (next.some((r) => normName(r.arofloValue) === normName(value))) continue;
      const ls = sources.find((s) => s.name === crmName);
      if (!ls) {
        missing.push(value);
        continue;
      }
      next.push({ arofloValue: value, leadSourceId: String(ls.id) });
    }
    setRows(next);
    setStatus((s) => ({
      ...s,
      message: missing.length
        ? `Added the approved mappings, except: ${missing.join(', ')} (their CRM Lead Source wasn't found). Nothing is saved until you press Save.`
        : 'Added the approved mappings to the table. Nothing is saved until you press Save.',
    }));
  }

  async function save() {
    setStatus((s) => ({ ...s, error: '', message: '' }));
    try {
      await api.settings.saveArofloLeadSourceMappings(rows.map((r) => ({ arofloValue: r.arofloValue, leadSourceId: r.leadSourceId || null })));
      await load();
      setStatus((s) => ({ ...s, message: 'Saved. Only future AroFlo lookups use these — no saved call was changed.' }));
    } catch (err) {
      setStatus((s) => ({ ...s, error: err.message }));
    }
  }

  async function loadAroflo() {
    setAroflo({ loading: true });
    try {
      setAroflo({ data: await api.arofloTest.leadSourceOptions() });
    } catch (err) {
      setAroflo({ error: err.message });
    }
  }

  // What each AroFlo value would suggest with the table as it stands.
  function effect(value) {
    const row = rows.find((r) => normName(r.arofloValue) === normName(value));
    if (row) {
      const ls = sources.find((s) => String(s.id) === String(row.leadSourceId));
      return { text: ls ? ls.name : '—', from: 'Your mapping' };
    }
    const exact = sources.filter((s) => normName(s.name) === normName(value));
    return exact.length === 1 ? { text: exact[0].name, from: 'Exact name' } : { text: 'Not mapped — reference only, staff choose', from: '—' };
  }
  const arofloValues = aroflo?.data
    ? [...new Map(aroflo.data.fields.flatMap((f) => f.options.map((o) => [normName(o), { value: o, fields: [] }]))).values()].map((v) => ({
        ...v,
        fields: aroflo.data.fields.filter((f) => f.options.some((o) => normName(o) === normName(v.value))).map((f) => f.name),
      }))
    : [];

  if (status.loading) return <div className="panel empty-state">Loading…</div>;
  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AroFlo Lead Source mappings</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 12 }}>
          Which CRM Lead Source an AroFlo customer Lead Source value means, for the AroFlo lookup on Calls &amp; Contacts. A mapping
          here overrides the exact-name match. The call form only suggests it (&quot;Use this&quot;) — it never replaces a Lead Source staff
          chose, and nothing is saved until the call is saved. Values with no mapping stay reference only. If a customer&apos;s two AroFlo
          fields (&quot;Lead Source&quot; and &quot;Lead/Referral Source&quot;) disagree, nothing is suggested. Saving here never changes any existing call.
        </div>
        {status.error && <div className="notice panel error" style={{ marginBottom: 10 }}>{status.error}</div>}
        {status.message && <div className="notice panel" style={{ marginBottom: 10 }}>{status.message}</div>}
        {rows.length === 0 ? (
          <div className="empty-state" style={{ marginBottom: 10 }}>No mappings yet — only exact-name matches are suggested.</div>
        ) : (
          <table className="data-table" data-testid="aroflo-lead-source-mappings">
            <thead>
              <tr>
                <th>AroFlo Lead Source value</th>
                <th>CRM Lead Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input value={r.arofloValue} onChange={(e) => update(i, { arofloValue: e.target.value })} placeholder="Exactly as in AroFlo" />
                    {r.broken && <div className="badge badge-warn" style={{ marginTop: 4 }}>Needs attention: {r.broken}</div>}
                  </td>
                  <td>
                    <SelectField value={r.leadSourceId} onChange={(v) => update(i, { leadSourceId: v })} options={sources} />
                  </td>
                  <td>
                    <button className="btn btn-sm" type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          <button className="btn" type="button" onClick={() => setRows((rs) => [...rs, { arofloValue: '', leadSourceId: '' }])}>
            Add mapping
          </button>
          <button className="btn" type="button" onClick={fillApproved}>
            Fill in the approved mappings
          </button>
          <button className="btn btn-primary" type="button" disabled={!dirty} onClick={save}>
            Save
          </button>
          {dirty && (
            <button className="btn" type="button" onClick={() => setRows(saved)}>
              Discard changes
            </button>
          )}
        </div>
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Check against AroFlo</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 10 }}>
          Lists every selectable AroFlo Lead Source value (read-only, no customer information) and what the call form would suggest
          with the table above — including unsaved changes.
        </div>
        <button className="btn" type="button" disabled={aroflo?.loading} onClick={loadAroflo}>
          {aroflo?.loading ? 'Loading…' : 'Load AroFlo Lead Source values'}
        </button>
        {aroflo?.error && <div style={{ marginTop: 10, color: 'var(--danger, #a3323a)' }}>{aroflo.error}</div>}
        {aroflo?.data && (
          <table className="data-table" style={{ marginTop: 12 }} data-testid="aroflo-lead-source-preview">
            <thead>
              <tr>
                <th>AroFlo value</th>
                <th>In AroFlo field(s)</th>
                <th>Call form suggests</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {arofloValues.map((v) => {
                const e = effect(v.value);
                return (
                  <tr key={v.value}>
                    <td>{v.value}</td>
                    <td>{v.fields.join(', ')}</td>
                    <td>{e.text}</td>
                    <td>{e.from}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
