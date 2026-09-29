import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogEntry from './LogEntry.jsx';
import JobHistory from './JobHistory.jsx';

export default function TechSalesPage({ sub, setSub, editing, setEditing, pendingJump, clearJump, jumpToJN }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
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
      // Continuation of the same "related call(s) →" click that already
      // pushed a history entry for the module switch — amend it, don't push
      // again.
      setSub('history', { push: false });
      clearJump();
    }
  }, [pendingJump, clearJump]);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 6000);
  }

  // Opening a record is a Back-stop: pressing Back should return to Job
  // History. setEditing pushes that entry; setSub folds the tab switch into
  // the same entry rather than creating a second one.
  function startEdit(entry) {
    setEditing(entry);
    setSub('log', { push: false });
  }

  // Cancelling or saving an edit is the mirror of opening it — go back to
  // the entry that was current before the edit started (Job History), the
  // same way the browser's own Back button would. Skipped for a brand new
  // (non-edit) log, which never pushed an entry to begin with.
  function closeEdit() {
    if (editing) window.history.back();
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
            closeEdit();
          }}
          onCancelEdit={closeEdit}
          setNotice={setNotice}
        />
      )}
      {sub === 'history' && (
        <JobHistory
          rows={rows}
          loading={loading}
          onEdit={startEdit}
          onChanged={load}
          jumpToJN={jumpToJN}
          initialJobNumber={initialJobNumber}
          setNotice={setNotice}
        />
      )}
    </div>
  );
}
