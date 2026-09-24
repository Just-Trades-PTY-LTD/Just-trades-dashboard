import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSessionState } from '../../lib/useSessionState.js';
import { SubTabs } from '../../components/Fields.jsx';
import LogCall from './LogCall.jsx';
import CallHistory from './CallHistory.jsx';

export default function CallsPage({ pendingJump, clearJump, jumpToJN }) {
  const [sub, setSub] = useSessionState('crm.calls.sub', 'log');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
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
      setSub('history');
      clearJump();
    }
  }, [pendingJump, clearJump]);

  function setNotice(message, isError) {
    setNoticeState({ message, isError });
    setTimeout(() => setNoticeState(null), 5000);
  }

  function startEdit(call) {
    setEditing(call);
    setSub('log');
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
            setEditing(null);
          }}
          onCancelEdit={() => setEditing(null)}
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
