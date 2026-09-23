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

// Same preview length/behaviour as Call History's comments preview — full
// text is always still available via title (hover) and the Edit form.
const NOTES_PREVIEW_LENGTH = 60;

function notesPreview(notes) {
  if (!notes) return null;
  const trimmed = notes.trim();
  return trimmed.length > NOTES_PREVIEW_LENGTH ? `${trimmed.slice(0, NOTES_PREVIEW_LENGTH)}…` : trimmed;
}

function emptyFilters() {
  return { from: '', to: '', technicianId: '', tradeId: '', entryType: '', jobNumber: '', includeArchived: false };
}

export default function JobHistory({ rows, loading, onEdit, onChanged, jumpToJN, initialJobNumber, setNotice }) {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [expandedId, setExpandedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());

  useEffect(() => {
    if (initialJobNumber) setFilters((f) => ({ ...f, jobNumber: initialJobNumber }));
  }, [initialJobNumber]);

  // Clear the selection whenever the filters change, so a selection never
  // silently carries over onto a different set of rows than what was picked.
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [filters]);

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

  // Entries come from four different underlying tables (job/sale/call_back/
  // pending_cancellation) whose own ids aren't unique across kinds, so
  // selection is tracked by the same "kind:id" composite key already used
  // for the history expansion below. Only currently-visible, not-yet-
  // archived rows can be selected.
  function entryKey(e) {
    return `${e.kind}:${e.id}`;
  }
  const selectableRows = filtered.filter((e) => !e.archived);
  const allSelected = selectableRows.length > 0 && selectableRows.every((e) => selectedKeys.has(entryKey(e)));

  function toggleSelectAll() {
    setSelectedKeys(allSelected ? new Set() : new Set(selectableRows.map(entryKey)));
  }

  function toggleSelected(key) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function archiveSelected() {
    const keys = [...selectedKeys];
    if (!keys.length) return;
    const n = keys.length;
    if (!window.confirm(`Archive ${n} entr${n === 1 ? 'y' : 'ies'}? This can be undone later with Unarchive.`)) return;
    await Promise.all(
      keys.map((key) => {
        const [kind, id] = key.split(':');
        return api.tech.archive(kind, id, true);
      })
    );
    setSelectedKeys(new Set());
    setNotice(`${n} entr${n === 1 ? 'y' : 'ies'} archived.`);
    onChanged();
  }

  async function toggleArchive(entry, archived) {
    await api.tech.archive(entry.kind, entry.id, archived);
    onChanged();
  }

  async function remove(entry) {
    if (!window.confirm('Delete this entry permanently?')) return;
    try {
      await api.tech.remove(entry.kind, entry.id);
      onChanged();
    } catch (err) {
      setNotice(err.message, true);
    }
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
        {selectedKeys.size > 0 && (
          <button className="btn btn-primary" type="button" onClick={archiveSelected}>
            Archive selected ({selectedKeys.size})
          </button>
        )}
        <a className="btn btn-primary" style={{ marginLeft: 'auto' }} href={api.tech.entriesXlsxUrl(filters)}>
          Export to Excel
        </a>
        <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{filtered.length} entries</div>
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
                <th>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={selectableRows.length === 0}
                    title="Select all"
                  />
                </th>
                <th>Date</th>
                <th>Entry type</th>
                <th>Technician</th>
                <th>JN</th>
                <th>Trade / job type</th>
                <th>Outcome</th>
                <th>Comments</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const key = `${e.kind}:${e.id}`;
                return (
                  <Fragment key={key}>
                    <tr style={e.archived ? { opacity: 0.55 } : undefined}>
                      <td>
                        {!e.archived && (
                          <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleSelected(key)} />
                        )}
                      </td>
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
                      <td style={{ maxWidth: 220, color: 'var(--ink-muted)', fontSize: 12.5 }} title={e.comments || undefined}>
                        {notesPreview(e.comments) || '—'}
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
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => remove(e)}
                            type="button"
                            disabled={e.canDelete === false}
                            title={e.canDelete === false ? 'This entry has linked sales or job information and cannot be permanently deleted. Please archive it instead.' : undefined}
                          >
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
                        <td colSpan={9} style={{ background: 'var(--surface-2)', fontSize: 12 }}>
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
