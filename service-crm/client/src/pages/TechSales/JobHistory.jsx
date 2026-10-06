import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { usePersistentFilters } from '../../lib/usePersistentFilters.js';
import { money } from '../../lib/dates.js';
import { DateField, FilterSelect, TextField, Checkbox, SelectField, AdvancedFiltersToggle } from '../../components/Fields.jsx';
import { formatAuditChanges } from '../../lib/audit.js';
import { withInactiveLabel } from '../../lib/activeOptions.js';

const ENTRY_TYPES = [
  { id: 'new_job_no_sale', name: 'New Job — No Sale' },
  { id: 'new_job_sale_made', name: 'New Job — Sale Made' },
  { id: 'quote_approved_later', name: 'Existing Job — Quote Approved Later' },
  { id: 'existing_job_upsell', name: 'Existing Job — Upsell' },
  { id: 'call_back', name: 'Call Back' },
  { id: 'pending_cancellation', name: 'Pending Cancellation' },
];

const WORK_COMPLETION_OPTIONS = [
  { id: 'Completed on this visit', name: 'Completed on this visit' },
  { id: 'Install scheduled — different day', name: 'Install scheduled — different day' },
];

const YES_NO_OPTIONS = [
  { id: 'yes', name: 'Yes' },
  { id: 'no', name: 'No' },
];

// Every Advanced Filters field, blank by default — kept separate from the
// always-visible quick filters so "how many are active" can be counted and
// Clear All only ever touches these.
const EMPTY_ADVANCED = {
  originalJobNumber: '',
  newJobNumber: '',
  suburb: '',
  jobTypeId: '',
  completingTechnicianId: '',
  saleMade: '',
  knockback: '',
  knockbackReasonId: '',
  workCompletion: '',
  convertedLater: '',
  hasCallBack: '',
  hasPendingCancellation: '',
  hasUpsell: '',
  createdByUserId: '',
  status: '',
};

// Same preview length/behaviour as Call History's comments preview — full
// text is always still available via title (hover) and the Edit form.
const NOTES_PREVIEW_LENGTH = 60;

function notesPreview(notes) {
  if (!notes) return null;
  const trimmed = notes.trim();
  return trimmed.length > NOTES_PREVIEW_LENGTH ? `${trimmed.slice(0, NOTES_PREVIEW_LENGTH)}…` : trimmed;
}

function emptyFilters() {
  return { from: '', to: '', technicianId: '', tradeId: '', entryType: '', jobNumber: '', includeArchived: false, q: '', ...EMPTY_ADVANCED };
}

const isJobKind = (e) => e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made';

// forceKnockbackLabel: set only when this list is the Technician & Sales
// report's "Actual Knockbacks" drill-down (see DrilldownModal.jsx). Every row
// there is, by that figure's own definition, a genuine Actual Knockback —
// regardless of the separate, permanent knock-back→converted flip a later
// Quote Approved Later sale on the same Job Number may have since set on it
// (see reports.js's computeConvertedLaterAdjustment(), which deliberately
// ignores that flip). Outside this one drill-down, that flip is still
// meaningful, accurate information about the job and is shown as normal;
// only here would showing "Converted later" instead of "Knock back" make an
// Actual Knockback record look like it belongs to the separate Converted
// Later figure instead.
export default function JobHistory({ rows, loading, onEdit, onChanged, jumpToJN, initialJobNumber, setNotice, embedded, forceKnockbackLabel }) {
  const settings = useSettings();
  const [filters, setFilters] = usePersistentFilters('crm.tech.historyFilters', emptyFilters, embedded);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Advanced Filters fields are "draft until applied" — typing here never
  // changes what's shown until "Apply Filters" is clicked, unlike the quick
  // filters above (and the keyword search), which stay live/instant exactly
  // as they always have.
  const [draft, setDraft] = useState(EMPTY_ADVANCED);
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

  function toggleAdvanced() {
    if (!advancedOpen) {
      setDraft({ ...EMPTY_ADVANCED, ...Object.fromEntries(Object.keys(EMPTY_ADVANCED).map((k) => [k, filters[k]])) });
    }
    setAdvancedOpen((o) => !o);
  }

  function applyAdvanced() {
    patch(draft);
  }

  function clearAdvanced() {
    setDraft(EMPTY_ADVANCED);
    patch(EMPTY_ADVANCED);
  }

  const advancedActiveCount = Object.keys(EMPTY_ADVANCED).filter((k) => filters[k] && filters[k] !== '').length;

  // Suburb options for the Advanced Filters dropdown — drawn from this
  // page's own already-loaded records (never a separate/duplicate settings
  // list), so it only ever lists suburbs that actually appear in Job History.
  const suburbOptions = useMemo(() => {
    const set = new Set(rows.map((e) => (e.suburb || '').trim()).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Filters this same table down to everything sharing a Job Number — used
  // by the "View original job"/"View linked callback" links below, so
  // clicking either one shows both the Call Back and its linked original job
  // side by side. Clears any active Entry type filter too, so the target is
  // never hidden by it. Not offered inside an embedded (report drill-down)
  // list, whose fixed row set may not include the linked record at all.
  function viewByJobNumber(jn) {
    patch({ jobNumber: jn, entryType: '' });
  }

  const filtered = rows.filter((e) => {
    if (filters.status === 'archived') {
      if (!e.archived) return false;
    } else if (filters.status === 'all') {
      // no status filter — every record regardless of archived state
    } else if (filters.status === 'active') {
      if (e.archived) return false;
    } else if (!filters.includeArchived && e.archived) {
      return false;
    }
    if (filters.from && (e.dateShown || '') < filters.from) return false;
    if (filters.to && (e.dateShown || '') > filters.to) return false;
    if (filters.technicianId && String(e.technicianId) !== String(filters.technicianId) && String(e.creditedTechnicianId) !== String(filters.technicianId)) return false;
    if (filters.tradeId && String(e.tradeId) !== String(filters.tradeId)) return false;
    if (filters.jobTypeId && String(e.jobTypeId) !== String(filters.jobTypeId)) return false;
    if (filters.entryType && e.kind !== filters.entryType) return false;
    if (filters.jobNumber) {
      // Matches either JN on a Quote Approved Later or Call Back entry — the
      // original job it's linked against, or its own separate New Job
      // Number. This is the combined quick filter; Original/New below are
      // the Advanced Filters panel's own, more precise pair.
      const q = filters.jobNumber.trim().toLowerCase();
      const matchesOriginal = (e.jobNumber || '').trim().toLowerCase() === q;
      const matchesNew = (e.newJobNumber || '').trim().toLowerCase() === q;
      if (!matchesOriginal && !matchesNew) return false;
    }
    if (filters.originalJobNumber && (e.jobNumber || '').trim().toLowerCase() !== filters.originalJobNumber.trim().toLowerCase()) return false;
    if (filters.newJobNumber && (e.newJobNumber || '').trim().toLowerCase() !== filters.newJobNumber.trim().toLowerCase()) return false;
    if (filters.suburb && (e.suburb || '').trim().toLowerCase() !== filters.suburb.trim().toLowerCase()) return false;
    if (filters.completingTechnicianId && String(e.completingTechnicianId) !== String(filters.completingTechnicianId)) return false;
    if (filters.createdByUserId && String(e.createdByUserId) !== String(filters.createdByUserId)) return false;
    if (filters.saleMade === 'yes' && !e.invoiceNumber) return false;
    if (filters.saleMade === 'no' && e.invoiceNumber) return false;
    // Knockback/Converted Later/Call Back/Pending Cancellation/Upsell below
    // are all concepts that only ever apply to a New Job entry — "No" is
    // scoped to job-kind rows explicitly (never silently pulling in an
    // unrelated Call Back/Quote Approved Later/etc. row just because it
    // trivially doesn't have the flag either) — mirrors listTechEntries()
    // server-side exactly, so the screen and the Excel export always agree.
    if (filters.knockback === 'yes' && e.knockback !== true) return false;
    if (filters.knockback === 'no' && !(isJobKind(e) && e.knockback === false)) return false;
    if (filters.knockbackReasonId && Number(e.knockbackReasonId) !== Number(filters.knockbackReasonId)) return false;
    if (filters.workCompletion && e.workCompletion !== filters.workCompletion) return false;
    if (filters.convertedLater === 'yes' && e.convertedLater !== true) return false;
    if (filters.convertedLater === 'no' && !(isJobKind(e) && e.convertedLater === false)) return false;
    if (filters.hasCallBack === 'yes' && !(e.relatedCallBackCount > 0)) return false;
    if (filters.hasCallBack === 'no' && !(isJobKind(e) && e.relatedCallBackCount === 0)) return false;
    if (filters.hasPendingCancellation === 'yes' && !(e.relatedPendingCancellationCount > 0)) return false;
    if (filters.hasPendingCancellation === 'no' && !(isJobKind(e) && e.relatedPendingCancellationCount === 0)) return false;
    if (filters.hasUpsell === 'yes' && !(e.relatedUpsellCount > 0)) return false;
    if (filters.hasUpsell === 'no' && !(isJobKind(e) && e.relatedUpsellCount === 0)) return false;
    if (filters.q && filters.q.trim()) {
      const key = filters.q.trim().toLowerCase();
      const haystack = `${e.jobNumber || ''} ${e.newJobNumber || ''} ${e.suburb || ''} ${e.comments || ''}`.toLowerCase();
      if (!haystack.includes(key)) return false;
    }
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
      {embedded ? (
        // This log is already a fixed set of records (a report drill-down) —
        // no filter bar, and no Export link, since that would export
        // everything matching these blank filters instead of just this set.
        selectedKeys.size > 0 && (
          <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="btn btn-primary" type="button" onClick={archiveSelected}>
              Archive selected ({selectedKeys.size})
            </button>
          </div>
        )
      ) : (
        <>
          <div className="panel" style={{ padding: 16, marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
            <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
            <FilterSelect
              label="Technician"
              value={filters.technicianId}
              onChange={(v) => patch({ technicianId: v })}
              options={withInactiveLabel(settings.technicians)}
            />
            <FilterSelect label="Trade" value={filters.tradeId} onChange={(v) => patch({ tradeId: v })} options={settings.trades} />
            <FilterSelect label="Entry type" value={filters.entryType} onChange={(v) => patch({ entryType: v })} options={ENTRY_TYPES} />
            <TextField
              label="Job number"
              placeholder="Original or New JN"
              value={filters.jobNumber}
              onChange={(v) => patch({ jobNumber: v })}
              mono
              maxWidth={160}
            />
            <TextField
              label="Keyword search"
              placeholder="Job #, suburb, comments…"
              value={filters.q}
              onChange={(v) => patch({ q: v })}
              maxWidth={200}
            />
            <div style={{ paddingBottom: 8 }}>
              <Checkbox label="Include archived" checked={filters.includeArchived} onChange={(v) => patch({ includeArchived: v })} />
            </div>
            <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
              Clear filters
            </button>
            <AdvancedFiltersToggle open={advancedOpen} onToggle={toggleAdvanced} activeCount={advancedActiveCount} />
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

          {advancedOpen && (
            <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Advanced Filters</div>
              <div className="grid-form">
                <TextField
                  label="Original Job Number"
                  value={draft.originalJobNumber}
                  onChange={(v) => setDraft((d) => ({ ...d, originalJobNumber: v }))}
                  mono
                />
                <TextField
                  label="New Job Number"
                  value={draft.newJobNumber}
                  onChange={(v) => setDraft((d) => ({ ...d, newJobNumber: v }))}
                  mono
                />
                <FilterSelect label="Suburb" value={draft.suburb} onChange={(v) => setDraft((d) => ({ ...d, suburb: v }))} options={suburbOptions} />
                <FilterSelect
                  label="Job type"
                  value={draft.jobTypeId}
                  onChange={(v) => setDraft((d) => ({ ...d, jobTypeId: v }))}
                  options={filters.tradeId ? settings.jobTypesFor(filters.tradeId) : []}
                />
                <FilterSelect
                  label="Technician who completed the work"
                  value={draft.completingTechnicianId}
                  onChange={(v) => setDraft((d) => ({ ...d, completingTechnicianId: v }))}
                  options={withInactiveLabel(settings.technicians)}
                />
                <SelectField
                  label="Sale Made"
                  value={draft.saleMade}
                  onChange={(v) => setDraft((d) => ({ ...d, saleMade: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <SelectField
                  label="Knockback"
                  value={draft.knockback}
                  onChange={(v) => setDraft((d) => ({ ...d, knockback: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <FilterSelect
                  label="Knockback reason"
                  value={draft.knockbackReasonId}
                  onChange={(v) => setDraft((d) => ({ ...d, knockbackReasonId: v }))}
                  options={settings.lists.knockback_reason}
                />
                <SelectField
                  label="Work completed"
                  value={draft.workCompletion}
                  onChange={(v) => setDraft((d) => ({ ...d, workCompletion: v }))}
                  options={WORK_COMPLETION_OPTIONS}
                  placeholder="All"
                />
                <SelectField
                  label="Converted Later"
                  value={draft.convertedLater}
                  onChange={(v) => setDraft((d) => ({ ...d, convertedLater: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <SelectField
                  label="Call Back"
                  value={draft.hasCallBack}
                  onChange={(v) => setDraft((d) => ({ ...d, hasCallBack: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <SelectField
                  label="Pending Cancellation"
                  value={draft.hasPendingCancellation}
                  onChange={(v) => setDraft((d) => ({ ...d, hasPendingCancellation: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <SelectField
                  label="Upsell"
                  value={draft.hasUpsell}
                  onChange={(v) => setDraft((d) => ({ ...d, hasUpsell: v }))}
                  options={YES_NO_OPTIONS}
                  placeholder="All"
                />
                <FilterSelect
                  label="Created By"
                  value={draft.createdByUserId}
                  onChange={(v) => setDraft((d) => ({ ...d, createdByUserId: v }))}
                  options={withInactiveLabel(settings.staffAll)}
                />
                <SelectField
                  label="Status"
                  value={draft.status}
                  onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                  options={[
                    { id: 'active', name: 'Active only' },
                    { id: 'archived', name: 'Archived only' },
                    { id: 'all', name: 'All (active + archived)' },
                  ]}
                  placeholder="Same as Include archived above"
                />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button className="btn btn-primary" type="button" onClick={applyAdvanced}>
                  Apply Filters
                </button>
                <button className="btn" type="button" onClick={clearAdvanced}>
                  Clear All
                </button>
              </div>
            </div>
          )}
        </>
      )}

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
                <th title="Only shown for Existing Job — Quote Approved Later or Call Back: the separate AroFlo Job Number created for the approved work / once the callback attendance is booked">New JN</th>
                <th>Trade / job type</th>
                <th>Suburb</th>
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
                        {!embedded && e.kind === 'call_back' && e.jobId && (
                          <div>
                            <button className="link-btn" style={{ fontSize: 11 }} onClick={() => viewByJobNumber(e.jobNumber)}>
                              View original job →
                            </button>
                          </div>
                        )}
                        {!embedded && (e.kind === 'new_job_no_sale' || e.kind === 'new_job_sale_made') && e.relatedCallBackCount > 0 && (
                          <div>
                            <button className="link-btn" style={{ fontSize: 11 }} onClick={() => viewByJobNumber(e.jobNumber)}>
                              {e.relatedCallBackCount} linked callback{e.relatedCallBackCount > 1 ? 's' : ''} →
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="mono">{e.kind === 'quote_approved_later' || e.kind === 'call_back' ? e.newJobNumber || '—' : ''}</td>
                      <td>
                        {e.tradeName}
                        {e.jobTypeName ? ` — ${e.jobTypeName}` : ''}
                      </td>
                      <td>{e.suburb || '—'}</td>
                      <td>
                        {e.kind === 'new_job_no_sale' && (!e.convertedLater || forceKnockbackLabel) && (
                          <span className="badge badge-warn">Knock back{e.knockbackReasonName ? `: ${e.knockbackReasonName}` : ''}</span>
                        )}
                        {e.kind === 'new_job_no_sale' && e.convertedLater && !forceKnockbackLabel && (
                          <span className="badge badge-success">Converted later</span>
                        )}
                        {(e.kind === 'new_job_sale_made' || e.kind === 'quote_approved_later') && e.invoiceNumber && (
                          <span className="badge badge-success">
                            {money(e.saleValueExGst)} ex GST — inv {e.invoiceNumber}
                          </span>
                        )}
                        {e.kind === 'existing_job_upsell' && (
                          <span className="badge badge-success">
                            Upsell: {money(e.saleValueExGst)} ex GST — inv {e.invoiceNumber}
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
