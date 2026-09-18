import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogEntry from './LogEntry.jsx';
import JobHistory from './JobHistory.jsx';

export default function TechSalesPage({ pendingJump, clearJump, jumpToJN }) {
  const [sub, setSub] = useState('log');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [notice, setNoticeState] = useState(null);
  const [initialJobNumber, setInitialJobNumber] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.tech.entries({ includeArchived: true });
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (pendingJump && pendingJump.target === 'tech') {
      setInitialJobNumber(pendingJump.jn);
      setSub('history');
      clearJump();
    }
  }, [pendingJump, clearJump]);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 6000);
  }

  function startEdit(entry) {
    setEditing(entry);
    setSub('log');
  }

  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['log', 'Log an entry'],
          ['history', 'Job history'],
        ]}
      />
      {notice && <div className={`notice panel ${notice.isError ? 'error' : ''}`}>{notice.message}</div>}
      {sub === 'log' && (
        <LogEntry
          editing={editing}
          onSaved={() => {
            load();
            setEditing(null);
          }}
          onCancelEdit={() => setEditing(null)}
          setNotice={setNotice}
        />
      )}
      {sub === 'history' && (
        <JobHistory rows={rows} loading={loading} onEdit={startEdit} onChanged={load} jumpToJN={jumpToJN} initialJobNumber={initialJobNumber} />
      )}
    </div>
  );
}
