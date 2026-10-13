import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { NumberField } from '../../components/Fields.jsx';

// Quote Follow-up trial — the one admin-editable setting it introduces. Lives
// here rather than a new subtab since it's the only follow-up-related config
// and this panel already holds the CRM's other few operational toggles.
function FollowUpDefaultsSection() {
  const { followUpDefaultDueDays, refresh } = useSettings();
  const [days, setDays] = useState(String(followUpDefaultDueDays));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setDays(String(followUpDefaultDueDays));
  }, [followUpDefaultDueDays]);

  async function save() {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) {
      setMessage('Please enter a whole number of days (1 or more).');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      await api.settings.updateFollowUpDefaultDueDays(n);
      await refresh();
      setMessage('Saved.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Quote follow-up — default due date</div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
        When "Follow-up required" is checked on a knock-back, the due date defaults to this many days after the original attendance
        date (shifted to the following Monday if that lands on a weekend). Always editable per follow-up before saving.
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <NumberField label="Default days" value={days} onChange={setDays} style={{ maxWidth: 120 }} />
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
          Save
        </button>
      </div>
      {message && <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8 }}>{message}</div>}
    </div>
  );
}

export default function DataPanel() {
  const fileInputRef = useRef(null);
  const [message, setMessage] = useState('');
  const [autoBackups, setAutoBackups] = useState([]);

  useEffect(() => {
    api.export.autoBackups().then(setAutoBackups).catch(() => {});
  }, []);

  function handleRestoreFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        if (
          !window.confirm(
            'This will replace all current settings, calls and technician & sales data with the contents of this backup file. Continue?'
          )
        )
          return;
        await api.export.restore(parsed);
        setMessage('Backup restored. Reloading…');
        setTimeout(() => window.location.reload(), 1000);
      } catch (err) {
        setMessage(`That file could not be restored: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function clearCalls() {
    if (!window.confirm('Clear all logged calls for everyone using this? Settings are kept.')) return;
    await api.export.clearCalls();
    setMessage('Call data cleared.');
  }

  async function clearTechData() {
    if (!window.confirm('Clear all technician & sales entries for everyone using this? Settings are kept.')) return;
    await api.export.clearTechData();
    setMessage('Technician & sales data cleared.');
  }

  return (
    <div className="panel span-2" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Data — export, backup and restore</div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        CSV exports are a snapshot for spreadsheets, not a full backup — archived records are included and flagged. Use the JSON backup
        to fully restore this CRM's data (staff accounts are not included in the backup).
      </div>
      {message && <div className="notice panel" style={{ marginBottom: 14 }}>{message}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <a className="btn" href={api.export.callsCsvUrl()}>
          Export calls (CSV)
        </a>
        <a className="btn" href={api.export.techCsvUrl()}>
          Export technician &amp; sales (CSV)
        </a>
        <a className="btn btn-primary" href={api.export.backupUrl()}>
          Export full backup (JSON)
        </a>
        <button className="btn" onClick={() => fileInputRef.current && fileInputRef.current.click()} type="button">
          Restore from backup…
        </button>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleRestoreFile} />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Automatic backups</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 8 }}>
          The server saves a full backup on its own every few hours — this list is for emergencies only, if data needs to be restored
          and nobody has a more recent manual export. These still live on the same server as the CRM, so also use "Export full backup"
          above every so often and save that copy somewhere else (e.g. Google Drive or email) for real safekeeping.
        </div>
        {autoBackups.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No automatic backups yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
            {autoBackups.map((b) => (
              <a key={b.filename} className="btn btn-sm" href={api.export.autoBackupUrl(b.filename)} style={{ alignSelf: 'flex-start' }}>
                {new Date(b.createdAt).toLocaleString()} ({Math.round(b.sizeBytes / 1024)} KB)
              </a>
            ))}
          </div>
        )}
      </div>
      <FollowUpDefaultsSection />
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Reset test data</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-danger" onClick={clearCalls} type="button">
            Clear call data
          </button>
          <button className="btn btn-danger" onClick={clearTechData} type="button">
            Clear job / sales data
          </button>
        </div>
      </div>
    </div>
  );
}
