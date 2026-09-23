import { Fragment, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { money } from '../../lib/dates.js';
import { DateField, FilterSelect, TextField, Checkbox } from '../../components/Fields.jsx';
import { formatAuditChanges } from '../../lib/audit.js';

const ENTRY_TYPES = [
  { id: 'new_job_no_sale', name: 'New Job — No Sale' },
  { id: 'new_job_sale_made', name: 'New Job — Sale Made' },
  { id: 'quote_approved_later', name: 'Existing Job — Quote Approved Later' },
  { id: 'call_back', name: 'Call Back' },
  { id: 'pending_cancellation', name: 'Pending Cancellation' },
];

function emptyFilters() {
  return { from: '', to: '', technicianId: '', tradeId: '', entryType: '', jobNumber: '', includeArchived: false };
}

export default function JobHistory({ rows, loading, onEdit, onChanged, jumpToJN, initialJobNumber }) {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [expandedId, setExpandedId] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (initialJobNumber) setFilters((f) => ({ ...f, jobNumber: initialJobNumber }));
  }, [initialJobNumber]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  const filtered = rows.filter((e) => {
    if (!filters.includeArchived && e.archived) return false;
    if (filters.from && (e.dateShown || '') < filters.from) return false;
    if (filters.to && (e.dateShown || '') > filters.to) return false;
    if (filters.technicianId && String(e.technicianId) !== String(filters.technicianId) && String(e.creditedTechnicianId) !== String(filters.technicianId)) return false;
    if (filters.tradeId && String(e.tradeId) !== String(filters.tradeId)) return false;
    if (filters.entryType && e.kind !== filters.entryType) return false;
    if (filters.jobNumber && (e.jobNumber || '').trim().toLowerCase() !== filters.jobNumber.trim().toLowerCase()) return false;
    return true;
  });

  async function toggleArchive(entry, archived) {
    await api.tech.archive(entry.kind, entry.id, archived);
    onChanged();
  }

  async function remove(entry) {
    if (!window.confirm('Delete this entry permanently?')) return;
    await api.tech.remove(entry.kind, entry.id);
    onChanged();
  }

  async function toggleHistory(entry) {
    const key = `${entry.kind}:${entry.id}`;
    if (expandedId === key) {
      setExpandedId(null);
      return;
    }
    const h = await api.tech.history(entry.kind, entry.id);
    setHistory(h);
    setExpandedId(key);
  }

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect label="Technician" value={filters.technicianId} onChange={(v) => patch({ technicianId: v })} options={settings.technicians} />
        <FilterSelect label="Trade" value={filters.tradeId} onChange={(v) => patch({ tradeId: v })} options={settings.trades} />
        <FilterSelect label="Entry type" value={filters.entryType} onChange={(v) => patch({ entryType: v })} options={ENTRY_TYPES} />
        <TextField label="Job number" value={filters.jobNumber} onChange={(v) => patch({ jobNumber: v })} mono maxWidth={160} />
        <div style={{ paddingBottom: 8 }}>
          <Checkbox label="Include archived" checked={filters.includeArchived} onChange={(v) => patch({ includeArchived: v })} />
        </div>
        <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
          Clear filters
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink-muted)' }}>{filtered.length} entries</div>
      </div>

      <div className="panel table-scroll">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No entries match these filters yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry type</th>
                <th>Technician</th>
                <th>JN</th>
                <th>Trade / job type</th>
                <th>Outcome</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const key = `${e.kind}:${e.id}`;
                return (
                  <Fragment key={key}>
                    <tr style={e.archived ? { opacity: 0.55 } : undefined}>
                      <td className="mono">{e.dateShown}</td>
                      <td>
                        {e.entryLabel}
                        {e.archived ? ' (archived)' : ''}
                      </td>
                      <td>{e.technicianName || e.creditedTechnicianName || '—'}</td>
                      <td className="mono">
                        {e.jobNumber}
                        {e.relatedCallsCount > 0 && (
                          <div>
                            <button className="link-btn" style={{ fontSize: 11 }} onClick={() => jumpToJN('calls', e.jobNumber)}>
                              {e.relatedCallsCount} related call{e.relatedCallsCount > 1 ? 's' : ''} →
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        {e.tradeName}
                        {e.jobTypeName ? ` — ${e.jobTypeName}` : ''}
                      </td>
                      <td>
                        {e.kind === 'new_job_no_sale' && !e.convertedLater && (
                          <span className="badge badge-warn">Knock back{e.knockbackReasonName ? `: ${e.knockbackReasonName}` : ''}</span>
                        )}
                        {e.kind === 'new_job_no_sale' && e.convertedLater && <span className="badge badge-success">Converted later</span>}
                        {(e.kind === 'new_job_sale_made' || e.kind === 'quote_approved_later') && e.invoiceNumber && (
                          <span className="badge badge-success">
                            {money(e.saleValueExGst)} ex GST — inv {e.invoiceNumber}
                          </span>
                        )}
                        {e.kind === 'call_back' && <span className="badge badge-info">{e.reasonName || 'Call back'}</span>}
                        {e.kind === 'pending_cancellation' && <span className="badge badge-alert">{e.reasonName || 'Pending cancellation'}</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="btn btn-sm" onClick={() => onEdit(e)} type="button">
                            Edit
                          </button>
                          {e.archived ? (
                            <button className="btn btn-sm" onClick={() => toggleArchive(e, false)} type="button">
                              Unarchive
                            </button>
                          ) : (
                            <button className="btn btn-sm" onClick={() => toggleArchive(e, true)} type="button">
                              Archive
                            </button>
                          )}
                          <button className="btn btn-sm btn-danger" onClick={() => remove(e)} type="button">
                            Delete
                          </button>
                          {e.historyCount > 0 && (
                            <button className="link-btn" style={{ fontSize: 11.5 }} onClick={() => toggleHistory(e)} type="button">
                              History ({e.historyCount})
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedId === key && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--surface-2)', fontSize: 12 }}>
                          {history.map((h) => (
                            <div key={h.id} style={{ padding: '6px 4px' }}>
                              <strong>{h.at}</strong> — {h.by}: {formatAuditChanges(h.changes)}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
