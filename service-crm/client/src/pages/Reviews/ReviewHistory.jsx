import { useState } from 'react';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { usePersistentFilters } from '../../lib/usePersistentFilters.js';
import { DateField, FilterSelect, TextField } from '../../components/Fields.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

const RATING_OPTIONS = [
  { id: '5', name: '5 stars' },
  { id: '4', name: '4 stars' },
  { id: '3', name: '3 stars' },
  { id: '2', name: '2 stars' },
  { id: '1', name: '1 star' },
];
const CLASSIFICATION_OPTIONS = [
  { id: 'Positive', name: 'Positive (4–5 stars)' },
  { id: 'Neutral', name: 'Neutral (3 stars)' },
  { id: 'Negative', name: 'Negative (1–2 stars)' },
];
const NOTES_PREVIEW_LENGTH = 60;

function emptyFilters() {
  return { from: '', to: '', technicianId: '', rating: '', ratingClass: '', reviewLinkSent: '', jobNumber: '', q: '' };
}

function notesPreview(notes) {
  if (!notes) return null;
  const trimmed = notes.trim();
  return trimmed.length > NOTES_PREVIEW_LENGTH ? `${trimmed.slice(0, NOTES_PREVIEW_LENGTH)}…` : trimmed;
}

function classificationBadgeClass(classification) {
  if (classification === 'Positive') return 'badge-success';
  if (classification === 'Neutral') return 'badge-warn';
  return 'badge-alert';
}

export default function ReviewHistory({ rows, loading, onEdit, embedded }) {
  const settings = useSettings();
  const [filters, setFilters] = usePersistentFilters('crm.reviews.historyFilters', emptyFilters, embedded);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  const filtered = rows.filter((r) => {
    if (filters.from && r.reviewDate < filters.from) return false;
    if (filters.to && r.reviewDate > filters.to) return false;
    if (filters.technicianId && !r.technicians.some((t) => String(t.id) === String(filters.technicianId))) return false;
    if (filters.rating && String(r.rating) !== String(filters.rating)) return false;
    if (filters.ratingClass && r.classification !== filters.ratingClass) return false;
    if (filters.reviewLinkSent && r.reviewLinkSent !== filters.reviewLinkSent) return false;
    if (filters.jobNumber && r.jobNumber.trim().toLowerCase() !== filters.jobNumber.trim().toLowerCase()) return false;
    if (filters.q && filters.q.trim()) {
      const key = filters.q.trim().toLowerCase();
      const haystack = `${r.jobNumber || ''} ${r.notes || ''} ${r.technicians.map((t) => t.name).join(' ')}`.toLowerCase();
      if (!haystack.includes(key)) return false;
    }
    return true;
  });

  return (
    <div>
      {!embedded && (
        <div className="panel" style={{ padding: 16, marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
          <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
          <FilterSelect
            label="Technician"
            value={filters.technicianId}
            onChange={(v) => patch({ technicianId: v })}
            options={withInactiveLabel(settings.technicians)}
          />
          <FilterSelect label="Star rating" value={filters.rating} onChange={(v) => patch({ rating: v, ratingClass: '' })} options={RATING_OPTIONS} />
          <FilterSelect
            label="Classification"
            value={filters.ratingClass}
            onChange={(v) => patch({ ratingClass: v, rating: '' })}
            options={CLASSIFICATION_OPTIONS}
          />
          <FilterSelect label="Review link sent" value={filters.reviewLinkSent} onChange={(v) => patch({ reviewLinkSent: v })} options={['Yes', 'No']} />
          <TextField label="Job number" value={filters.jobNumber} onChange={(v) => patch({ jobNumber: v })} mono maxWidth={160} />
          <TextField
            label="Keyword search"
            placeholder="Job #, notes, technician…"
            value={filters.q}
            onChange={(v) => patch({ q: v })}
            maxWidth={220}
          />
          <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
            Clear filters
          </button>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginLeft: 'auto' }}>{filtered.length} reviews</div>
        </div>
      )}

      <div className="panel table-scroll">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No reviews match these filters yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Review date</th>
                <th>Rating</th>
                <th>Classification</th>
                <th>Technician(s)</th>
                <th>Review link sent</th>
                <th>JN</th>
                <th>Notes / reference</th>
                <th>Entered by</th>
                <th>Last edited</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.reviewDate}</td>
                  <td>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</td>
                  <td>
                    <span className={`badge ${classificationBadgeClass(r.classification)}`}>{r.classification}</span>
                  </td>
                  <td>{r.technicians.map((t) => t.name).join(', ') || '—'}</td>
                  <td>{r.reviewLinkSent || '—'}</td>
                  <td className="mono">{r.jobNumber || '—'}</td>
                  <td style={{ maxWidth: 220, color: 'var(--ink-muted)', fontSize: 12.5 }} title={r.notes || undefined}>
                    {notesPreview(r.notes) || '—'}
                  </td>
                  <td>{r.createdByName || '—'}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
                    {r.lastEditedByName ? (
                      <>
                        {r.lastEditedByName}
                        <div className="mono" style={{ fontSize: 11 }}>
                          {r.updatedAt}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {onEdit && (
                      <button className="btn btn-sm" onClick={() => onEdit(r)} type="button">
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
