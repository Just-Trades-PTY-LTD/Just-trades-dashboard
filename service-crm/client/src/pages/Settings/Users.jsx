import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useSettings } from '../../lib/SettingsContext.jsx';

function emptyForm() {
  return { name: '', email: '', password: '', role: 'staff' };
}

// What each account type can use — shown as a key and on every account.
const TYPES = {
  admin: { label: 'Admin', badge: 'badge-warn', access: 'Everything, including Settings and staff accounts.' },
  staff: { label: 'Staff', badge: 'badge-success', access: 'Calls & Contacts, Technician & Sales, Follow-ups, Reviews and Reports. No Settings.' },
  technician: { label: 'Technician', badge: 'badge-info', access: 'Only their own My Performance, My Reviews and My account.' },
};

function TypeBadge({ u }) {
  const t = TYPES[u.accessType] || TYPES.staff;
  const text = u.accessType === 'technician' ? `Technician — ${u.technicianName}` : t.label;
  return (
    <span className={`badge ${t.badge}`} title={t.access} data-testid="account-type">
      {text}
    </span>
  );
}

const plainEmail = (u) => (u.emailReleased ? '(email released)' : u.email);

export default function Users() {
  const { user: me } = useAuth();
  const { refresh: refreshSettings, technicians } = useSettings();
  // Technician access dialog: { user, mode: 'link' | 'unlink' }.
  const [access, setAccess] = useState(null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);

  function reload() {
    api.users.list().then(setUsers);
  }
  useEffect(reload, []);

  async function act(fn, done) {
    setError('');
    setMessage('');
    try {
      await fn();
      if (done) setMessage(done);
      reload();
      refreshSettings();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createUser(e) {
    e.preventDefault();
    await act(async () => {
      await api.users.create(form);
      setForm(emptyForm());
    }, 'Account created.');
  }

  const toggleActive = (u) => act(() => api.users.update(u.id, { active: !u.active }), `${u.name} ${u.active ? 'deactivated' : 'reactivated'}.`);

  function changeType(u, to) {
    const t = TYPES[to];
    const ok = window.confirm(
      `Change ${u.name} from ${TYPES[u.role].label} to ${t.label}?\n\n${t.label}: ${t.access}\n\nTheir records and history stay exactly as they are.`
    );
    if (ok) act(() => api.users.update(u.id, { role: to }), `${u.name} is now ${t.label}.`);
  }

  async function resetPassword(u) {
    const password = window.prompt(`New password for ${u.name} (min 8 characters):`);
    if (!password) return;
    act(() => api.users.update(u.id, { password }), `Password updated for ${u.name}.`);
  }

  function remove(u) {
    const ok = window.confirm(
      `Remove ${u.name}?\n\n• They can't sign in while removed.\n• Their name stays on every record and in history.\n• Their email stays reserved.\n• You can restore the account later (Removed accounts).`
    );
    if (ok) act(() => api.users.remove(u.id), `${u.name} removed. Restore it any time under Removed accounts.`);
  }

  function restore(u) {
    let email;
    if (u.emailReleased) {
      email = window.prompt(`${u.name}'s email was released. Enter an email to restore the account with:`);
      if (!email) return;
    } else if (!window.confirm(`Restore ${u.name}? It comes back inactive with the same account type — reactivate it when it's needed.`)) return;
    act(() => api.users.restore(u.id, email), `${u.name} restored (still inactive).`);
  }

  function releaseEmail(u) {
    const ok = window.confirm(
      `Release ${u.email} so another account can use it?\n\n${u.name} stays removed and keeps all its records. Restoring it later will need a new email. The original email is kept in Settings Activity.`
    );
    if (ok) act(() => api.users.releaseEmail(u.id), `Email released from ${u.name}.`);
  }

  function deletePermanently(u) {
    const typed = window.prompt(`Permanently delete ${u.name}? This can't be undone.\n\nIt isn't linked to any record. Type the account name to confirm:`);
    if (typed === null) return;
    act(() => api.users.deletePermanently(u.id, typed), `${u.name} was permanently deleted.`);
  }

  const activeAdminCount = users.filter((u) => u.role === 'admin' && u.active && !u.removed).length;
  const nameCounts = users.reduce((m, u) => m.set(u.name.trim().toLowerCase(), (m.get(u.name.trim().toLowerCase()) || 0) + 1), new Map());
  const current = users.filter((u) => !u.removed);
  const groups = [
    ['Administrators', current.filter((u) => u.active && u.accessType === 'admin')],
    ['Staff', current.filter((u) => u.active && u.accessType === 'staff')],
    ['Technicians', current.filter((u) => u.active && u.accessType === 'technician')],
    ['Inactive', current.filter((u) => !u.active)],
  ];
  const removed = users.filter((u) => u.removed);

  function Row({ u }) {
    const isLastActiveAdmin = u.role === 'admin' && u.active && activeAdminCount <= 1;
    const isTech = u.accessType === 'technician';
    const duplicate = nameCounts.get(u.name.trim().toLowerCase()) > 1;
    const linked = u.links?.total > 0;
    return (
      <div className="list-row" data-testid="account-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 6 }}>
        <div style={{ opacity: u.active && !u.removed ? 1 : 0.65, minWidth: 220 }}>
          <div style={{ fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{u.name}</strong> {u.id === me.id && <span style={{ color: 'var(--ink-muted)' }}>(you)</span>}
            <TypeBadge u={u} />
            {duplicate && (
              <span className="badge" style={{ background: 'var(--surface-2)' }} title="Another account has the same name — check it isn't a duplicate">
                Same name as another account
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{plainEmail(u)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
            {(TYPES[u.accessType] || TYPES.staff).access}
            {isTech && !u.technicianActive && <strong> Blocked while the technician record is inactive.</strong>}
          </div>
          {!u.active && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>{linked ? `Linked to ${u.links.text}.` : 'Not linked to any record.'}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {u.removed ? (
            <>
              <button className="btn btn-sm" type="button" onClick={() => restore(u)}>
                Restore…
              </button>
              {!u.emailReleased && (
                <button className="btn btn-sm" type="button" onClick={() => releaseEmail(u)}>
                  Release email…
                </button>
              )}
            </>
          ) : (
            <>
              {u.active && !isTech && u.role === 'staff' && (
                <button className="btn btn-sm" type="button" onClick={() => changeType(u, 'admin')}>
                  Change to Admin…
                </button>
              )}
              {u.active && !isTech && u.role === 'admin' && (
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={u.id === me.id || isLastActiveAdmin}
                  title={u.id === me.id ? "You can't change your own account type." : isLastActiveAdmin ? 'The last active administrator must stay Admin.' : undefined}
                  onClick={() => changeType(u, 'staff')}
                >
                  Change to Staff…
                </button>
              )}
              {u.active && !isTech && u.role === 'staff' && (
                <button className="btn btn-sm" onClick={() => setAccess({ user: u, mode: 'link' })} type="button">
                  Change to Technician…
                </button>
              )}
              {isTech && (
                <button className="btn btn-sm" onClick={() => setAccess({ user: u, mode: 'unlink' })} type="button">
                  Change back to Staff…
                </button>
              )}
              <button className="btn btn-sm" onClick={() => resetPassword(u)} type="button">
                Reset password
              </button>
              <button
                className="btn btn-sm"
                disabled={u.id === me.id || isLastActiveAdmin}
                title={u.id === me.id ? "You can't deactivate your own account." : isLastActiveAdmin ? "You can't deactivate the last active administrator account." : undefined}
                onClick={() => toggleActive(u)}
                type="button"
              >
                {u.active ? 'Deactivate' : 'Reactivate'}
              </button>
              {!u.active && u.id !== me.id && (
                <button className="btn btn-sm" type="button" onClick={() => remove(u)}>
                  Remove…
                </button>
              )}
            </>
          )}
          {!u.active && u.id !== me.id && !linked && (
            <button className="btn btn-sm btn-danger" type="button" onClick={() => deletePermanently(u)}>
              Delete permanently…
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid-charts">
      <div className="panel" style={{ padding: 18 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>Staff accounts</div>
        <div className="panel" style={{ padding: 10, marginBottom: 12, fontSize: 12 }} data-testid="account-type-key">
          {Object.values(TYPES).map((t) => (
            <div key={t.label} style={{ marginBottom: 3 }}>
              <span className={`badge ${t.badge}`}>{t.label}</span> {t.access}
            </div>
          ))}
          <div style={{ color: 'var(--ink-muted)', marginTop: 4 }}>
            Changing type: Technician → Staff → Admin, one confirmed step at a time. Only Admins can change account types.
          </div>
        </div>
        {message && <div className="notice panel" style={{ marginBottom: 10 }} role="status">{message}</div>}
        {error && <div className="notice error" style={{ marginBottom: 10 }}>{error}</div>}
        {users.some((u) => u.accessType === 'technician') && (
          <div style={{ marginBottom: 12 }}>
            <RollbackWarning />
          </div>
        )}
        {groups.map(([title, list]) =>
          list.length ? (
            <div key={title} style={{ marginBottom: 12 }} data-testid={`account-group-${title}`}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '8px 0 2px' }}>
                {title} ({list.length})
              </div>
              {list.map((u) => (
                <Row key={u.id} u={u} />
              ))}
            </div>
          ) : null
        )}
        {removed.length > 0 && (
          <div style={{ marginTop: 6 }} data-testid="removed-accounts">
            <button className="btn btn-sm" type="button" aria-expanded={showRemoved} onClick={() => setShowRemoved((v) => !v)}>
              {showRemoved ? 'Hide' : 'Show'} removed accounts ({removed.length})
            </button>
            {showRemoved && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11.5, color: 'var(--ink-muted)', marginBottom: 4 }}>
                  Removed accounts can't sign in. Their names stay on all their records and history, and their emails stay reserved.
                </div>
                {removed.map((u) => (
                  <Row key={u.id} u={u} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {access && (
        <TechnicianAccessDialog
          access={access}
          technicians={technicians}
          onCancel={() => setAccess(null)}
          onDone={() => {
            setAccess(null);
            reload();
          }}
        />
      )}

      <form className="panel" style={{ padding: 18 }} onSubmit={createUser}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>Add a staff account</div>
        <div className="grid-form">
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </div>
          <div className="field">
            <label>Email</label>
            <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
          </div>
          <div className="field">
            <label>Temporary password</label>
            <input type="text" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required minLength={8} />
          </div>
          <div className="field">
            <label>Account type</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="staff">Staff — {TYPES.staff.access}</option>
              <option value="admin">Admin — {TYPES.admin.access}</option>
            </select>
          </div>
        </div>
        <button type="submit" className="btn btn-primary" style={{ marginTop: 14 }}>
          Create account
        </button>
      </form>
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Shown wherever Technician accounts exist or are being created: a CRM
// version from before Technician access doesn't know about the link, so it
// would treat every Technician account as an ordinary Staff account.
function RollbackWarning() {
  return (
    <div className="notice error" data-testid="technician-rollback-warning" style={{ fontSize: 12.5 }}>
      <strong>Before any CRM rollback:</strong> rolling the CRM back to a version from before Technician access existed would treat
      every Technician account as an ordinary Staff account, with full Staff access. Before any such rollback, change every Technician
      account back to Staff or deactivate it. A rollback is never a safe way to remove Technician access.
    </div>
  );
}

// Change an existing Staff account to Technician (linked to one active
// technician record), or back to Staff. Nothing changes until Confirm; the
// server re-checks everything and signs the account out on either change.
function TechnicianAccessDialog({ access, technicians, onCancel, onDone }) {
  const { user, mode } = access;
  const [technicianId, setTechnicianId] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    if (mode !== 'link' || !technicianId) return;
    api.users.technicianPreview(user.id, technicianId).then(setPreview).catch((err) => setError(err.message));
  }, [mode, technicianId, user.id]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'link') await api.users.linkTechnician(user.id, Number(technicianId));
      else await api.users.unlinkTechnician(user.id);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const canConfirm = mode === 'unlink' || (preview && preview.blockers.length === 0);
  return (
    <div className="drilldown-overlay" style={{ zIndex: 1100 }} onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="panel drilldown-panel" style={{ maxWidth: 620 }} role="dialog" aria-label="Technician access">
        <div className="drilldown-header">
          <h3 style={{ margin: 0 }}>{mode === 'link' ? `Change ${user.name} to a Technician account` : `Change ${user.name} back to Staff`}</h3>
        </div>
        <div className="drilldown-body" style={{ fontSize: 13.5 }}>
          <p style={{ marginTop: 0 }}>
            Account: <strong>{user.name}</strong> ({user.email})
          </p>
          {mode === 'link' ? (
            <>
              <div className="field" style={{ maxWidth: 320 }}>
                <label>Technician record</label>
                <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
                  <option value="">Choose a technician…</option>
                  {technicians
                    .filter((t) => t.active)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </div>
              {preview && preview.blockers.length > 0 && (
                <div className="notice error" style={{ marginTop: 10 }}>{preview.blockers.join(' ')}</div>
              )}
              {preview && preview.blockers.length === 0 && (
                <ul data-testid="technician-link-summary">
                  <li>
                    Links this account to <strong>{preview.technician.name}</strong> ({plural(preview.counts.jobs, 'job')},{' '}
                    {plural(preview.counts.sales, 'sale')}, {plural(preview.counts.reviews, 'review')} credited to that technician).
                  </li>
                  <li>
                    They will only see <strong>My Performance</strong>, <strong>My Reviews</strong> and their account — no Calls & Contacts,
                    Technician & Sales entries, company Reports, Follow-ups, other technicians or Settings.
                  </li>
                  <li>Their login, password, account and all existing records and history stay exactly as they are.</li>
                  <li>They will be signed out now and need to sign in again.</li>
                </ul>
              )}
              {preview && preview.blockers.length === 0 && <RollbackWarning />}
            </>
          ) : (
            <ul data-testid="technician-unlink-summary">
              <li>
                This <strong>restores the broader Staff access</strong>: Calls & Contacts, Technician & Sales entries and history, company
                Reports, Follow-ups and Reviews for every technician.
              </li>
              <li>It removes the link to {user.technicianName}. Their login, password, account and all records stay exactly as they are.</li>
              <li>They will be signed out now and need to sign in again.</li>
            </ul>
          )}
          {error && <div className="notice error" style={{ marginTop: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" onClick={confirm} disabled={!canConfirm || busy}>
              {busy ? 'Working…' : mode === 'link' ? 'Confirm — change to Technician' : 'Confirm — restore Staff access'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
