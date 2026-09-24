import { Fragment, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { DateField, FilterSelect, TextField, Checkbox } from '../../components/Fields.jsx';
import { formatAuditChanges } from '../../lib/audit.js';
import { contactMethodLabel } from '../../lib/contactMethods.js';

const CALL_TYPES = ['Lead', 'Not lead', 'Quote approved', 'Call back', 'Cancellation'];
const NOTES_PREVIEW_LENGTH = 60;

function notesPreview(notes) {
  if (!notes) return null;
  const trimmed = notes.trim();
  return trimmed.length > NOTES_PREVIEW_LENGTH ? `${trimmed.slice(0, NOTES_PREVIEW_LENGTH)}…` : trimmed;
}

function emptyFilters() {
  return { from: '', to: '', handledByUserId: '', callType: '', jobNumber: '', includeArchived: false };
}

export default function CallHistory({ rows, loading, onEdit, onChanged, jumpToJN, initialJobNumber, setNotice }) {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [expandedId, setExpandedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    if (initialJobNumber) setFilters((f) => ({ ...f, jobNumber: initialJobNumber }));
  }, [initialJobNumber]);

  // Clear the selection whenever the filters change, so a selection never
  // silently carries over onto a different set of rows than what was picked.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  const filtered = rows.filter((c) => {
    if (!filters.includeArchived && c.archived) return false;
    if (filters.from && (c.callAt || '') < filters.from) return false;
    if (filters.to && (c.callAt || '') > `${filters.to}T23:59`) return false;
    if (filters.handledByUserId && String(c.handledByUserId) !== String(filters.handledByUserId)) return false;
    if (filters.callType && c.callType !== filters.callType) return false;
    if (filters.jobNumber && c.jobNumber.trim().toLowerCase() !== filters.jobNumber.trim().toLowerCase()) return false;
    return true;
  });

  // Only currently-visible, not-yet-archived rows can be selected — Select
  // All only ever selects what's on screen under the active filters, and
  // there's nothing useful to "archive" on a row that's already archived.
  const selectableRows = filtered.filter((c) => !c.archived);
  const allSelected = selectableRows.length > 0 && selectableRows.every((c) => selectedIds.has(c.id));

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(selectableRows.map((c) => c.id)));
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function archiveSelected() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const n = ids.length;
    if (!window.confirm(`Archive ${n} call${n === 1 ? '' : 's'}? This can be undone later with Unarchive.`)) return;
    await Promise.all(ids.map((id) => api.calls.archive(id, true)));
    setSelectedIds(new Set());
    setNotice(`${n} call${n === 1 ? '' : 's'} archived.`);
    onChanged();
  }

  async function toggleArchive(id, archived) {
    await api.calls.archive(id, archived);
    onChanged();
  }

  async function remove(id) {
    if (!window.confirm('Delete this call permanently?')) return;
    await api.calls.remove(id);
    onChanged();
  }

  async function toggleHistory(call) {
    if (expandedId === call.id) {
      setExpandedId(null);
      return;
    }
    const h = await api.calls.history(call.id);
    setHistory(h);
    setExpandedId(call.id);
  }

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect label="Staff" value={filters.handledByUserId} onChange={(v) => patch({ handledByUserId: v })} options={settings.staff} />
        <FilterSelect label="Call type" value={filters.callType} onChange={(v) => patch({ callType: v })} options={CALL_TYPES} />
        <TextField label="Job number" value={filters.jobNumber} onChange={(v) => patch({ jobNumber: v })} mono maxWidth={160} />
        <div style={{ paddingBottom: 8 }}>
          <Checkbox label="Include archived" checked={filters.includeArchived} onChange={(v) => patch({ includeArchived: v })} />
        </div>
        <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
          Clear filters
        </button>
        {selectedIds.size > 0 && (
          <button className="btn btn-primary" type="button" onClick={archiveSelected}>
            Archive selected ({selectedIds.size})
          </button>
        )}
        <a className="btn btn-primary" style={{ marginLeft: 'auto' }} href={api.calls.exportXlsxUrl(filters)}>
          Export to Excel
        </a>
        <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{filtered.length} calls</div>
      </div>

      <div className="panel table-scroll">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No calls match these filters yet.</div>
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
                <th>Date / time</th>
                <th>Contact Method</th>
                <th>Staff</th>
                <th>Call type</th>
                <th>Trade / job type</th>
                <th>Suburb</th>
                <th>Outcome</th>
                <th>JN</th>
                <th>Comments</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <Fragment key={c.id}>
                  <tr style={c.archived ? { opacity: 0.55 } : undefined}>
                    <td>
                      {!c.archived && (
                        <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelected(c.id)} />
                      )}
                    </td>
                    <td className="mono">{(c.callAt || '').replace('T', ' ')}</td>
                    <td>{contactMethodLabel(c.direction)}</td>
                    <td>{c.handledByName || '—'}</td>
                    <td>
                      {c.callType}
                      {c.archived ? ' (archived)' : ''}
                    </td>
                    <td>
                      {c.tradeName}
                      {c.jobTypeName ? ` — ${c.jobTypeName}` : ''}
                    </td>
                    <td>{c.suburb}</td>
                    <td>
                      {c.callType === 'Cancellation' && (
                        <span className="badge badge-alert">
                          {c.cancellationType || 'Cancelled'}
                          {c.cancellationReasonName ? `: ${c.cancellationReasonName}` : ''}
                        </span>
                      )}
                      {c.callType === 'Lead' && c.booked === 'Yes' && <span className="badge badge-success">Booked</span>}
                      {c.callType === 'Lead' && c.booked === 'No' && (
                        <span className="badge badge-warn">Not booked{c.notBookedReasonName ? `: ${c.notBookedReasonName}` : ''}</span>
                      )}
                      {c.callType === 'Quote approved' && <span className="badge badge-info">Quote approved</span>}
                      {c.callType === 'Call back' && <span className="badge badge-info">{c.callBackReasonName || 'Call back'}</span>}
                    </td>
                    <td className="mono">
                      {c.jobNumber}
                      {c.jobNumber && c.linkedJob && (
                        <div>
                          <button className="link-btn" style={{ fontSize: 11 }} onClick={() => jumpToJN('tech', c.jobNumber)}>
                            View job →
                          </button>
                        </div>
                      )}
                    </td>
                    <td style={{ maxWidth: 220, color: 'var(--ink-muted)', fontSize: 12.5 }} title={c.notes || undefined}>
                      {notesPreview(c.notes) || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-sm" onClick={() => onEdit(c)} type="button">
                          Edit
                        </button>
                        {c.archived ? (
                          <button className="btn btn-sm" onClick={() => toggleArchive(c.id, false)} type="button">
                            Unarchive
                          </button>
                        ) : (
                          <button className="btn btn-sm" onClick={() => toggleArchive(c.id, true)} type="button">
                            Archive
                          </button>
                        )}
                        <button className="btn btn-sm btn-danger" onClick={() => remove(c.id)} type="button">
                          Delete
                        </button>
                        {c.historyCount > 0 && (
                          <button className="link-btn" style={{ fontSize: 11.5 }} onClick={() => toggleHistory(c)} type="button">
                            History ({c.historyCount})
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === c.id && (
                    <tr>
                      <td colSpan={11} style={{ background: 'var(--surface-2)', fontSize: 12 }}>
                        {history.map((h) => (
                          <div key={h.id} style={{ padding: '6px 4px' }}>
                            <strong>{h.at}</strong> — {h.by}: {formatAuditChanges(h.changes)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
