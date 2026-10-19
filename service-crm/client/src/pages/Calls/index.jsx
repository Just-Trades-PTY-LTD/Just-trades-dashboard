import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogCall from './LogCall.jsx';
import CallHistory from './CallHistory.jsx';

export default function CallsPage({ sub, setSub, editing, setEditing, pendingJump, clearJump, jumpToJN }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNoticeState] = useState(null);
  const [initialJobNumber, setInitialJobNumber] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.calls.list({ includeArchived: true });
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (pendingJump && pendingJump.target === 'calls') {
      setInitialJobNumber(pendingJump.jn);
      // Continuation of the same "View job →" click that already pushed a
      // history entry for the module switch — amend it, don't push again.
      setSub('history', { push: false });
      clearJump();
    }
  }, [pendingJump, clearJump]);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 5000);
  }

  // Opening a record is a Back-stop: pressing Back should return to Contact
  // History. setEditing pushes that entry; setSub folds the tab switch into
  // the same entry rather than creating a second one.
  function startEdit(call) {
    setEditing(call);
    setSub('log', { push: false });
  }

  // Deliberately NOT window.history.back() — this screen can be reached by
  // more than one browser-history hop depending on how the user navigated
  // here (e.g. the record's own persisted sub-tab, or a different number of
  // clicks to get here), so popping one entry off the real history stack
  // doesn't reliably land back on Contact History — it can just as easily
  // overshoot to an earlier, unrelated page (e.g. Home). Clearing the edit
  // state directly instead always returns to Contact History, with no
  // record left stuck in edit mode. Skipped for a brand new (non-edit) log,
  // which was never a Back-stop in the first place.
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
          ['log', 'Log a contact'],
          ['history', 'Contact history'],
        ]}
      />
      {notice && <div className={`notice panel ${notice.isError ? 'error' : ''}`}>{notice.message}</div>}
      {sub === 'log' && (
        <LogCall
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
        <CallHistory
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
