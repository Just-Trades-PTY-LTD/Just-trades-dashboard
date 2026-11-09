import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { SelectField, Checkbox } from '../../components/Fields.jsx';
import { matchJobType, normName } from '../../lib/arofloCallSuggest.js';

// Admin only: AroFlo task type -> CRM Trade / Job type. Only shapes FUTURE
// AroFlo lookups on the Calls & Contacts and Technician & Sales forms
// (suggestions, and blank fields on a new entry — always editable). Saving
// here never changes any saved call or job. An explicit mapping overrides the
// exact-name match; a task type with neither is left for staff.

const KIND_OPTIONS = [
  { id: 'full', name: 'One Trade and Job type' },
  { id: 'tradeOnly', name: 'Trade only — staff choose the Job type' },
  { id: 'callback', name: 'Call Back — no Trade / Job type' },
];

// The mappings approved for this account (Nov 2026), by CRM name. Only fills
// the table below — nothing is saved until an admin presses Save.
const APPROVED = [
  ['Air Conditioning Installation', 'full', 'Heating & Cooling', ['Installation']],
  ['Air Conditioning Servicing', 'full', 'Heating & Cooling', ['Servicing']],
  ['Air Conditioning Faults', 'full', 'Heating & Cooling', ['Faults']],
  ['Ongoing Servicing', 'full', 'Heating & Cooling', ['Servicing']],
  ['Gas Appliances', 'full', 'Plumbing', ['Gas Fitting']],
  ['Gas and Water Piping', 'tradeOnly', 'Plumbing', ['Gas Fitting', 'Burst Pipe']],
  ['Call Back', 'callback', null, []],
];

const blankRow = () => ({ arofloTaskType: '', kind: 'full', tradeId: '', jobTypeId: '', choiceJobTypeIds: [] });

function describe(row, trades) {
  if (row.kind === 'callback') return 'Call Back (no Trade / Job type)';
  const trade = trades.find((t) => String(t.id) === String(row.tradeId));
  if (!trade) return '—';
  if (row.kind === 'full') {
    const jt = trade.jobTypes.find((j) => String(j.id) === String(row.jobTypeId));
    return jt ? `${trade.name} — ${jt.name}` : `${trade.name} — ?`;
  }
  const names = trade.jobTypes.filter((j) => row.choiceJobTypeIds.map(String).includes(String(j.id))).map((j) => j.name);
  return `${trade.name} — staff choose ${names.join(' or ') || '?'}`;
}

export default function ArofloMappings() {
  const settings = useSettings();
  const trades = settings.trades || [];
  const [rows, setRows] = useState([]);
  const [saved, setSaved] = useState([]);
  const [status, setStatus] = useState({ loading: true, error: '', message: '' });
  const [aroflo, setAroflo] = useState(null);

  async function load() {
    try {
      const { mappings } = await api.settings.arofloTaskTypeMappings();
      const asRows = mappings.map((m) => ({
        arofloTaskType: m.arofloTaskType,
        kind: m.kind,
        tradeId: m.tradeId ? String(m.tradeId) : '',
        jobTypeId: m.jobTypeId ? String(m.jobTypeId) : '',
        choiceJobTypeIds: (m.choiceJobTypeIds || []).map(String),
        broken: m.broken || null,
      }));
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

  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, broken: null } : r)));
  const dirty = JSON.stringify(rows.map(({ broken, ...r }) => r)) !== JSON.stringify(saved.map(({ broken, ...r }) => r));

  function fillApproved() {
    const missing = [];
    const next = [...rows];
    for (const [name, kind, tradeName, jobTypeNames] of APPROVED) {
      if (next.some((r) => normName(r.arofloTaskType) === normName(name))) continue;
      const trade = trades.find((t) => t.name === tradeName);
      const jts = trade ? jobTypeNames.map((n) => trade.jobTypes.find((j) => j.name === n)) : [];
      if (kind !== 'callback' && (!trade || jts.some((j) => !j))) {
        missing.push(name);
        continue;
      }
      next.push({
        arofloTaskType: name,
        kind,
        tradeId: trade ? String(trade.id) : '',
        jobTypeId: kind === 'full' ? String(jts[0].id) : '',
        choiceJobTypeIds: kind === 'tradeOnly' ? jts.map((j) => String(j.id)) : [],
      });
    }
    setRows(next);
    setStatus((s) => ({
      ...s,
      message: missing.length
        ? `Added the approved mappings, except: ${missing.join(', ')} (their CRM Trade / Job type wasn't found). Nothing is saved until you press Save.`
        : 'Added the approved mappings to the table. Nothing is saved until you press Save.',
    }));
  }

  async function save() {
    setStatus((s) => ({ ...s, error: '', message: '' }));
    try {
      await api.settings.saveArofloTaskTypeMappings(
        rows.map((r) => ({
          arofloTaskType: r.arofloTaskType,
          kind: r.kind,
          tradeId: r.tradeId || null,
          jobTypeId: r.jobTypeId || null,
          choiceJobTypeIds: r.choiceJobTypeIds,
        }))
      );
      await load();
      setStatus((s) => ({ ...s, message: 'Saved. Only future AroFlo lookups use these — no saved call or job was changed.' }));
    } catch (err) {
      setStatus((s) => ({ ...s, error: err.message }));
    }
  }

  async function loadAroflo() {
    setAroflo({ loading: true });
    try {
      setAroflo({ data: await api.arofloTest.taskTypesAll() });
    } catch (err) {
      setAroflo({ error: err.message });
    }
  }

  // What each AroFlo task type would do with the table as it stands (saved or not).
  function effect(name) {
    const row = rows.find((r) => normName(r.arofloTaskType) === normName(name));
    if (row) return { text: describe(row, trades), source: 'mapping' };
    const jt = matchJobType(name, trades);
    return jt ? { text: jt.label, source: 'exact name' } : { text: 'Left for staff', source: 'none' };
  }

  if (status.loading) return <div className="panel empty-state">Loading…</div>;
  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AroFlo task type mappings</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 12 }}>
          Which CRM Trade / Job type an AroFlo task type means, for the AroFlo lookup on Calls &amp; Contacts and Technician &amp;
          Sales. A mapping here always overrides the exact-name match. Task types with neither are left for staff. Lookups only
          suggest values or fill blank fields on a new entry — always editable, nothing saved until staff save. Saving here never
          changes any existing call or job.
        </div>
        {status.error && <div className="notice panel error" style={{ marginBottom: 10 }}>{status.error}</div>}
        {status.message && <div className="notice panel" style={{ marginBottom: 10 }}>{status.message}</div>}
        {rows.length === 0 ? (
          <div className="empty-state" style={{ marginBottom: 10 }}>No mappings yet — only exact-name matches are used.</div>
        ) : (
          <table className="data-table" data-testid="aroflo-mappings">
            <thead>
              <tr>
                <th>AroFlo task type</th>
                <th>Maps to</th>
                <th>Trade</th>
                <th>Job type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const trade = trades.find((t) => String(t.id) === String(r.tradeId));
                return (
                  <tr key={i}>
                    <td>
                      <input value={r.arofloTaskType} onChange={(e) => update(i, { arofloTaskType: e.target.value })} placeholder="Exactly as in AroFlo" />
                      {r.broken && <div className="badge badge-warn" style={{ marginTop: 4 }}>Needs attention: {r.broken}</div>}
                    </td>
                    <td>
                      <SelectField value={r.kind} onChange={(v) => update(i, { kind: v, jobTypeId: '', choiceJobTypeIds: [] })} options={KIND_OPTIONS} />
                    </td>
                    <td>
                      {r.kind === 'callback' ? (
                        '—'
                      ) : (
                        <SelectField value={r.tradeId} onChange={(v) => update(i, { tradeId: v, jobTypeId: '', choiceJobTypeIds: [] })} options={trades} />
                      )}
                    </td>
                    <td>
                      {r.kind === 'full' && trade && (
                        <SelectField value={r.jobTypeId} onChange={(v) => update(i, { jobTypeId: v })} options={trade.jobTypes} />
                      )}
                      {r.kind === 'tradeOnly' &&
                        trade &&
                        trade.jobTypes.map((j) => (
                          <Checkbox
                            key={j.id}
                            label={j.name}
                            checked={r.choiceJobTypeIds.includes(String(j.id))}
                            onChange={(on) =>
                              update(i, {
                                choiceJobTypeIds: on ? [...r.choiceJobTypeIds, String(j.id)] : r.choiceJobTypeIds.filter((x) => x !== String(j.id)),
                              })
                            }
                          />
                        ))}
                      {r.kind === 'callback' && '—'}
                    </td>
                    <td>
                      <button className="btn btn-sm" type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          <button className="btn" type="button" onClick={() => setRows((rs) => [...rs, blankRow()])}>
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
          Lists every AroFlo task type (active and archived, read-only) and what it would do with the table above — including
          unsaved changes.
        </div>
        <button className="btn" type="button" disabled={aroflo?.loading} onClick={loadAroflo}>
          {aroflo?.loading ? 'Loading…' : 'Load AroFlo task types'}
        </button>
        {aroflo?.error && <div style={{ marginTop: 10, color: 'var(--danger, #a3323a)' }}>{aroflo.error}</div>}
        {aroflo?.data && (
          <table className="data-table" style={{ marginTop: 12 }} data-testid="aroflo-mapping-preview">
            <thead>
              <tr>
                <th>AroFlo task type</th>
                <th>Status</th>
                <th>Result in the forms</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {['active', 'archived'].flatMap((key) =>
                (aroflo.data[key]?.available ? aroflo.data[key].data?.items || [] : []).map((t) => {
                  const e = effect(t.name);
                  return (
                    <tr key={`${key}-${t.id}`}>
                      <td>{t.name}</td>
                      <td>{key === 'active' ? 'Active' : 'Archived'}</td>
                      <td>{e.text}</td>
                      <td>{e.source === 'mapping' ? 'Your mapping' : e.source === 'exact name' ? 'Exact name' : '—'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
