import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogEntry from './LogEntry.jsx';
import JobHistory from './JobHistory.jsx';

export default function TechSalesPage({ sub, setSub, editing, setEditing, pendingJump, clearJump, jumpToJN, openFollowUp }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNoticeState] = useState(null);
  const [initialJobNumber, setInitialJobNumber] = useState('');
  // Set only by jumpToJobId (see App.jsx's "View original knockback job" —
  // the embedded report drill-down's own exact-job jump, whose fixed row set
  // doesn't include the matching job row to filter locally).
  const [initialJobId, setInitialJobId] = useState(null);

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
      if (pendingJump.jobId !== undefined) setInitialJobId(pendingJump.jobId);
      else setInitialJobNumber(pendingJump.jn);
      // Continuation of the same "related call(s) →"/"View original
      // knockback job →" click that already pushed a history entry for the
      // module switch — amend it, don't push again.
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

  // Deliberately NOT window.history.back() — this screen can be reached by
  // more than one browser-history hop depending on how the user navigated
  // here, so popping one entry off the real history stack doesn't reliably
  // land back on Job History — it can just as easily overshoot to an
  // earlier, unrelated page (e.g. Home). Clearing the edit state directly
  // instead always returns to Job History, with no record left stuck in
  // edit mode. Skipped for a brand new (non-edit) log, which was never a
  // Back-stop in the first place.
  function closeEdit() {
    if (editing) {
      setEditing(null, { push: false });
      setSub('history', { push: false });
    }
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
          initialJobId={initialJobId}
          setNotice={setNotice}
          openFollowUp={openFollowUp}
        />
      )}
    </div>
  );
}
