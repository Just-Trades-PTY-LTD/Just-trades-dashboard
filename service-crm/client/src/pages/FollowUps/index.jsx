import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { SubTabs, TextField, SelectField, DateField, TextAreaField } from '../../components/Fields.jsx';

// Quote Follow-up trial — a purely operational reminder list, entirely
// separate from reporting (see routes/followUps.js's own file comment): this
// page never reads or writes anything that any report figure depends on.

const CLOSE_OUTCOMES = [
  { id: 'quote_approved', name: 'Quote Approved' },
  { id: 'quote_rejected', name: 'Quote Rejected' },
  { id: 'unable_to_contact', name: 'Unable to Contact' },
  { id: 'no_longer_required', name: 'No Longer Required' },
  { id: 'other', name: 'Other' },
];

const OUTCOME_LABEL = Object.fromEntries(CLOSE_OUTCOMES.map((o) => [o.id, o.name]));

const BUCKET_LABEL = { overdue: 'Overdue', due_today: 'Due Today', upcoming: 'Upcoming' };
const BUCKET_BADGE_CLASS = { overdue: 'badge-alert', due_today: 'badge-warn', upcoming: 'badge-info' };

function BucketBadge({ bucket }) {
  return <span className={`badge ${BUCKET_BADGE_CLASS[bucket] || 'badge-info'}`}>{BUCKET_LABEL[bucket] || bucket}</span>;
}

function EntryTable({ entries, onOpen, showOutcome }) {
  if (!entries.length) return <div className="empty-state">Nothing here.</div>;
  return (
    <div className="table-scroll">
    <table className="data-table">
      <thead>
        <tr>
          <th>Due date</th>
          <th></th>
          <th>Original JN</th>
          <th>Suburb</th>
          <th>Technician</th>
          <th>Trade / job type</th>
          {showOutcome && <th>Outcome</th>}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(e.id)}>
            <td className="mono">{e.dueDate}</td>
            <td>{e.bucket && <BucketBadge bucket={e.bucket} />}</td>
            <td className="mono">{e.jobNumber}</td>
            <td>{e.suburb || '—'}</td>
            <td>{e.technicianName || '—'}</td>
            <td>
              {e.tradeName}
              {e.jobTypeName ? ` — ${e.jobTypeName}` : ''}
            </td>
            {showOutcome && <td>{OUTCOME_LABEL[e.closedOutcome] || e.closedOutcome}</td>}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function ActiveList({ onOpen }) {
  const [data, setData] = useState({ entries: [], overdueCount: 0, today: '' });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.followUps.list({ status: 'active' });
      setData(res);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="empty-state">Loading…</div>;

  const overdue = data.entries.filter((e) => e.bucket === 'overdue');
  const dueToday = data.entries.filter((e) => e.bucket === 'due_today');
  const upcoming = data.entries.filter((e) => e.bucket === 'upcoming');

  return (
    <div>
      {data.overdueCount > 0 && (
        <div className="notice panel error" style={{ marginBottom: 16 }}>
          {data.overdueCount} follow-up{data.overdueCount > 1 ? 's are' : ' is'} overdue.
        </div>
      )}
      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Overdue ({overdue.length})</div>
        <EntryTable entries={overdue} onOpen={onOpen} />
      </div>
      <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Due today ({dueToday.length})</div>
        <EntryTable entries={dueToday} onOpen={onOpen} />
      </div>
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Upcoming ({upcoming.length})</div>
        <EntryTable entries={upcoming} onOpen={onOpen} />
      </div>
    </div>
  );
}

function CompletedList({ onOpen, q, setQ }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (keyword) => {
    setLoading(true);
    try {
      const res = await api.followUps.list({ status: 'closed', q: keyword });
      setEntries(res.entries);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <TextField label="Search" placeholder="Job number or suburb…" value={q} onChange={setQ} maxWidth={240} />
        <button className="btn" type="button" onClick={() => load(q)}>
          Search
        </button>
      </div>
      <div className="panel" style={{ padding: 16 }}>
        {loading ? <div className="empty-state">Loading…</div> : <EntryTable entries={entries} onOpen={onOpen} showOutcome />}
      </div>
    </div>
  );
}

function FollowUpDetail({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const [newDueDate, setNewDueDate] = useState('');
  const [rescheduleNote, setRescheduleNote] = useState('');
  const [outcome, setOutcome] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [reopenNote, setReopenNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const d = await api.followUps.get(id);
    setData(d);
    setNewDueDate(d.dueDate);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    await run(async () => {
      await api.followUps.addNote(id, note);
      setNote('');
      await load();
    });
  }

  async function reschedule() {
    if (!newDueDate) {
      setError('Please choose a new due date.');
      return;
    }
    await run(async () => {
      await api.followUps.updateDueDate(id, newDueDate, rescheduleNote);
      setRescheduleNote('');
      await load();
    });
  }

  async function close() {
    if (!outcome) {
      setError('Please choose an outcome before closing.');
      return;
    }
    await run(async () => {
      await api.followUps.close(id, outcome, closeNote);
      await load();
    });
  }

  async function reopen() {
    await run(async () => {
      await api.followUps.reopen(id, reopenNote);
      setReopenNote('');
      await load();
    });
  }

  if (!data) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <button className="link-btn" type="button" onClick={onClose} style={{ marginBottom: 12 }}>
        ← Back to list
      </button>

      <div className="panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              Original JN <span className="mono">{data.jobNumber}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginTop: 4 }}>
              {data.suburb || '—'} · {data.technicianName || '—'} · {data.tradeName}
              {data.jobTypeName ? ` — ${data.jobTypeName}` : ''} · attended {data.originalAttendanceDate}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {data.status === 'active' ? (
              <span className="badge badge-info">Due {data.dueDate}</span>
            ) : (
              <span className="badge badge-success">Closed — {OUTCOME_LABEL[data.closedOutcome] || data.closedOutcome}</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="notice panel error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Notes &amp; history</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 280, overflowY: 'auto', marginBottom: 14 }}>
          {data.events.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>No activity yet.</div>
          ) : (
            data.events.map((ev) => (
              <div key={ev.id} style={{ fontSize: 12.5, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div style={{ color: 'var(--ink-muted)' }}>
                  {ev.at} — {ev.byName}
                  {ev.kind === 'reschedule' && ev.previousDueDate && ev.newDueDate && (
                    <> · due date changed {ev.previousDueDate} → {ev.newDueDate}</>
                  )}
                  {ev.kind === 'closed' && ' · closed'}
                  {ev.kind === 'reopened' && ' · reopened'}
                  {ev.kind === 'created' && ' · follow-up created'}
                </div>
                {ev.note && <div style={{ marginTop: 2 }}>{ev.note}</div>}
              </div>
            ))
          )}
        </div>
        <TextAreaField label="Add a note" value={note} onChange={setNote} rows={2} />
        <button className="btn" type="button" onClick={addNote} disabled={busy || !note.trim()} style={{ marginTop: 8 }}>
          Add note
        </button>
      </div>

      <div className="panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Change due date</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField label="New due date" value={newDueDate} onChange={setNewDueDate} />
          <TextField label="Note (optional)" value={rescheduleNote} onChange={setRescheduleNote} maxWidth={260} />
          <button className="btn btn-primary" type="button" onClick={reschedule} disabled={busy}>
            Save due date
          </button>
        </div>
      </div>

      {data.status === 'active' ? (
        <div className="panel" style={{ padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Close this follow-up</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <SelectField label="Outcome" value={outcome} onChange={setOutcome} options={CLOSE_OUTCOMES} />
            <TextField label="Note (optional)" value={closeNote} onChange={setCloseNote} maxWidth={260} />
            <button className="btn btn-primary" type="button" onClick={close} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="panel" style={{ padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Reopen</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <TextField label="Note (optional)" value={reopenNote} onChange={setReopenNote} maxWidth={260} />
            <button className="btn" type="button" onClick={reopen} disabled={busy}>
              Reopen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FollowUpsPage({ sub, setSub, editing, setEditing }) {
  const [refreshKey, setRefreshKey] = useState(0);
  // Lifted up here (rather than local state inside CompletedList) so it
  // survives the list <-> detail transition below, which unmounts/remounts
  // CompletedList — otherwise the search box would silently clear every time
  // a completed follow-up was opened and closed again.
  const [closedQuery, setClosedQuery] = useState('');

  function openDetail(id) {
    setEditing(id);
  }
  // Deliberately NOT window.history.back() — this page can be reached by
  // more than one browser-history "hop" (e.g. the Follow-ups tab, then a
  // sub-tab switch, then opening a task; or arriving via "View follow-up" in
  // Job History, which opens the detail directly), so popping one entry off
  // the real history stack does not reliably land back on this page — it can
  // just as easily surface whatever the user was looking at several steps
  // earlier (Reports, Job History, ...). Clearing `editing` directly always
  // returns to the Follow-ups list itself, with its current section
  // (Outstanding/Completed) and search untouched; `push: false` amends the
  // current history entry in place rather than growing the stack.
  function closeDetail() {
    setEditing(null, { push: false });
  }
  function onChanged() {
    setRefreshKey((k) => k + 1);
  }

  if (editing) {
    return <FollowUpDetail key={`${editing}-${refreshKey}`} id={editing} onClose={closeDetail} onChanged={onChanged} />;
  }

  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['active', 'Outstanding'],
          ['closed', 'Completed'],
        ]}
      />
      {sub === 'closed' ? (
        <CompletedList onOpen={openDetail} q={closedQuery} setQ={setClosedQuery} />
      ) : (
        <ActiveList key={refreshKey} onOpen={openDetail} />
      )}
    </div>
  );
}
