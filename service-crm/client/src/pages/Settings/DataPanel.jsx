import { useRef, useState } from 'react';
import { api } from '../../lib/api.js';

export default function DataPanel() {
  const fileInputRef = useRef(null);
  const [message, setMessage] = useState('');

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
