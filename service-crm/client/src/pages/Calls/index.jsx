import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
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

  // Opening a record — a brand new blank form or an existing one to edit —
  // is a Back-stop: pressing Back (or Cancel/Save, which do the same thing
  // programmatically — see closeForm) should return to the recent contacts
  // list. (Both buttons that call these only ever render in the
  // recent-contacts view, so there's never a form open here already to warn
  // about losing — see LogCall's own Cancel button and App.jsx's tab switch
  // for where that warning lives.)
  function startEdit(call) {
    // setEditing always actually changes value here (null/another record ->
    // this one), so it alone pushes the Back-stop; setSub folds the sub-tab
    // switch into that same entry rather than creating a second one.
    setEditing(call);
    setSub('log', { push: false });
  }

  function startNew() {
    // editing is already null on every path that can reach this button, so
    // setEditing(null) is a no-op push-wise — setSub must push the Back-stop
    // itself here, unlike startEdit above.
    setEditing(null);
    setSub('log');
  }

  // Cancelling or saving either a new contact or an edit is the mirror of
  // opening it — go back to the entry that was current before the form
  // opened (the recent contacts list), the same way the browser's own Back
  // button would.
  function closeForm() {
    window.history.back();
  }

  return (
    <div>
      {notice && <div className={`notice panel ${notice.isError ? 'error' : ''}`}>{notice.message}</div>}
      {sub === 'log' ? (
        <LogCall
          editing={editing}
          onSaved={() => {
            load();
            closeForm();
          }}
          onCancel={closeForm}
          // Only reached if a navigation action elsewhere (e.g. switching the
          // top-level tab) overrides LogCall's own unsaved-changes warning —
          // its own Cancel button goes through closeForm instead. Resets
          // back to the recent contacts list so coming back to this page
          // later shows the list, not the form that was just abandoned.
          onLeaveWithoutSaving={() => {
            setEditing(null);
            setSub('history', { push: false });
          }}
          setNotice={setNotice}
        />
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
            <button className="btn btn-primary" type="button" onClick={startNew}>
              + Add New Contact
            </button>
          </div>
          <CallHistory
            rows={rows}
            loading={loading}
            onEdit={startEdit}
            onChanged={load}
            jumpToJN={jumpToJN}
            initialJobNumber={initialJobNumber}
            setNotice={setNotice}
          />
        </>
      )}
    </div>
  );
}
