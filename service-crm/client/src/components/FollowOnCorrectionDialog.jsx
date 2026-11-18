import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// "Correct follow-on link" (Admin and Staff; the server refuses anyone else).
// Staff enter the correct earlier approved Job Number, see the current link
// and the proposed replacement side by side (with the chain before and
// after), give a required reason and confirm. Only the link and the Original
// Job Number change; the confirm sends the preview's token, so if anything
// changed in between, nothing is applied.
// See docs/follow-on-approved-quote-design.md §8.

function Side({ title, side, testid }) {
  return (
    <div className="panel" style={{ padding: 10, flex: 1, minWidth: 220 }} data-testid={testid}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5 }}>Follows on from: {side.link.summary}</div>
      {side.link.creditedTechnician && <div style={{ fontSize: 12.5 }}>Credited to {side.link.creditedTechnician}</div>}
      {side.link.archived && <div style={{ fontSize: 12.5, color: 'var(--danger, #b42318)' }}>That sale is archived.</div>}
      <div style={{ fontSize: 12.5 }}>
        Original Job Number: <span className="mono">{side.originalJobNumber || '—'}</span>
      </div>
      <div style={{ fontSize: 12.5 }}>Chain: {side.chain}</div>
    </div>
  );
}

export default function FollowOnCorrectionDialog({ entry, onCancel, onDone }) {
  const [jobNumber, setJobNumber] = useState('');
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  async function check() {
    setError('');
    setPreview(null);
    setBusy(true);
    try {
      setPreview(await api.tech.followOnLinkPreview(entry.id, jobNumber.trim()));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await api.tech.followOnLinkApply(entry.id, { jobNumber: jobNumber.trim(), reason, token: preview.token });
      onDone(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="drilldown-overlay" style={{ zIndex: 1100 }} onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="panel drilldown-panel" style={{ maxWidth: 720 }} role="dialog" aria-modal="true" aria-label="Correct follow-on link">
        <div className="drilldown-header">
          <h3 style={{ margin: 0 }}>Correct follow-on link</h3>
        </div>
        <div className="drilldown-body">
          <p style={{ marginTop: 0, fontSize: 13 }}>
            Follow-on approved quote <span className="mono">JN {entry.jobNumber} → {entry.newJobNumber}</span>
            {entry.invoiceNumber ? ` · invoice ${entry.invoiceNumber}` : ''}. Current chain: {entry.followOnChain?.text || '—'}
          </p>
          <div className="field" style={{ maxWidth: 360 }}>
            <label>Correct earlier approved Job Number *</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="mono"
                value={jobNumber}
                onChange={(e) => {
                  setJobNumber(e.target.value);
                  setPreview(null);
                }}
                placeholder="New Job Number of the earlier approved sale"
                data-testid="followon-fix-jn"
              />
              <button className="btn" type="button" onClick={check} disabled={busy || !jobNumber.trim()} data-testid="followon-fix-check">
                Check
              </button>
            </div>
          </div>
          {error && (
            <p style={{ color: 'var(--danger, #b42318)' }} data-testid="followon-fix-error">
              {error}
            </p>
          )}
          {preview && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <Side title="Current" side={preview.current} testid="followon-fix-current" />
                <Side title="Proposed" side={preview.proposed} testid="followon-fix-proposed" />
              </div>
              {preview.laterFollowOns.length > 0 && (
                <p style={{ fontSize: 12.5 }}>
                  Later follow-ons that move with this sale: {preview.laterFollowOns.join('; ')}
                </p>
              )}
              <p style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>{preview.unchanged}</p>
              <div className="field">
                <label>Reason for the correction *</label>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{ width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 5, font: 'inherit' }}
                  data-testid="followon-fix-reason"
                />
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
                Recorded in the history of all three sales and in Activity history. Earlier history entries are kept.
              </p>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={confirm}
              disabled={!preview || busy || !reason.trim()}
              data-testid="followon-fix-confirm"
            >
              {busy && preview ? 'Working…' : 'Confirm correction'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
