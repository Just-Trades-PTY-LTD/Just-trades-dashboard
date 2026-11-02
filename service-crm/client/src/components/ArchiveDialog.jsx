import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// The one way to archive or unarchive anything (admins only). Opening it only
// previews — nothing changes until the admin clicks the confirm button, and
// Cancel / Escape / clicking outside makes no further request at all. The
// confirm sends back the preview's token, so if the records changed in the
// meantime the server refuses and nothing is applied.
// `request` is { items: [{kind, id}], archived: boolean }, or
// { linkQalSaleId } for linking an unlinked Quote Approved Later sale to its
// original knock-back job (same preview -> confirm flow).
export default function ArchiveDialog({ request, onCancel, onDone }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isLink = !!request.linkQalSaleId;
  const verb = isLink ? 'Link' : request.archived ? 'Archive' : 'Unarchive';

  useEffect(() => {
    let live = true;
    (isLink ? api.archive.linkQalPreview(request.linkQalSaleId) : api.archive.preview(request.items, request.archived))
      .then((p) => live && setPreview(p))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [request, isLink]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = isLink
        ? await api.archive.linkQalApply(request.linkQalSaleId, preview.token)
        : await api.archive.apply(request.items, request.archived, preview.token);
      onDone(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="drilldown-overlay" style={{ zIndex: 1100 }} onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="panel drilldown-panel" style={{ maxWidth: 620 }} role="dialog" aria-modal="true" aria-label={`${verb} confirmation`}>
        <div className="drilldown-header">
          <h3 style={{ margin: 0 }}>{verb} — please confirm</h3>
        </div>
        <div className="drilldown-body">
          {!preview && !error && <p>Checking linked records…</p>}
          {error && <p style={{ color: 'var(--danger, #b42318)' }}>{error}</p>}
          {preview && (
            <>
              <p style={{ marginTop: 0 }}>
                <strong>
                  {verb} {preview.entries} record{preview.entries === 1 ? '' : 's'}:
                </strong>
              </p>
              <ul data-testid="archive-counts">
                {Object.entries(preview.countsByType).map(([type, n]) => (
                  <li key={type}>
                    {n} × {type}
                  </li>
                ))}
              </ul>
              <p style={{ marginBottom: 4 }}>
                <strong>Exactly what will change:</strong>
              </p>
              <ul data-testid="archive-changes">
                {preview.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              {preview.linkedChanges.length > 0 ? (
                <p style={{ fontSize: 13 }}>
                  Includes {preview.linkedChanges.length} linked record change{preview.linkedChanges.length === 1 ? '' : 's'} (listed above).
                </p>
              ) : (
                <p style={{ fontSize: 13 }}>No linked records are changed.</p>
              )}
              {preview.notes.length > 0 && (
                <>
                  <p style={{ marginBottom: 4 }}>
                    <strong>Please note:</strong>
                  </p>
                  <ul data-testid="archive-notes">
                    {preview.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </>
              )}
              <p style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                Everything above happens together or not at all, and is recorded in Activity history.
              </p>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" onClick={confirm} disabled={!preview || busy}>
              {busy ? 'Working…' : `Confirm ${verb.toLowerCase()}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
