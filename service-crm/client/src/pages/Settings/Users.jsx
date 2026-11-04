import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useSettings } from '../../lib/SettingsContext.jsx';

function emptyForm() {
  return { name: '', email: '', password: '', role: 'staff' };
}

export default function Users() {
  const { user: me } = useAuth();
  const { refresh: refreshSettings, technicians } = useSettings();
  // Technician access dialog: { user, mode: 'link' | 'unlink' }.
  const [access, setAccess] = useState(null);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState('');

  function reload() {
    api.users.list().then(setUsers);
  }
  useEffect(reload, []);

  async function createUser(e) {
    e.preventDefault();
    setError('');
    try {
      await api.users.create(form);
      setForm(emptyForm());
      reload();
      refreshSettings();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleActive(u) {
    setError('');
    try {
      await api.users.update(u.id, { active: !u.active });
      reload();
      refreshSettings();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleRole(u) {
    await api.users.update(u.id, { role: u.role === 'admin' ? 'staff' : 'admin' });
    reload();
  }

  async function resetPassword(u) {
    const password = window.prompt(`New password for ${u.name} (min 8 characters):`);
    if (!password) return;
    try {
      await api.users.update(u.id, { password });
      window.alert('Password updated.');
    } catch (err) {
      window.alert(err.message);
    }
  }

  const activeAdminCount = users.filter((u) => u.role === 'admin' && u.active).length;

  return (
    <div className="grid-charts">
      <div className="panel" style={{ padding: 18 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>Staff accounts</div>
        {error && <div className="notice error" style={{ marginBottom: 10 }}>{error}</div>}
        {users.some((u) => u.accessType === 'technician') && (
          <div style={{ marginBottom: 12 }}>
            <RollbackWarning />
          </div>
        )}
        {users.map((u) => {
          const isLastActiveAdmin = u.role === 'admin' && u.active && activeAdminCount <= 1;
          return (
            <div key={u.id} className="list-row" style={{ justifyContent: 'space-between' }}>
              <div style={{ opacity: u.active ? 1 : 0.5 }}>
                <div style={{ fontSize: 13.5 }}>
                  {u.name} {u.id === me.id && <span style={{ color: 'var(--ink-muted)' }}>(you)</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{u.email}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {u.active ? (
                  <span className="badge badge-success">Active</span>
                ) : (
                  <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--ink-muted)' }}>
                    Inactive
                  </span>
                )}
                {u.accessType === 'technician' ? (
                  <>
                    <span className="badge badge-info" title="Can only see My Performance and My Reviews for this technician record">
                      Technician — {u.technicianName}
                      {u.technicianActive ? '' : ' (inactive — account blocked)'}
                    </span>
                    <button className="btn btn-sm" onClick={() => setAccess({ user: u, mode: 'unlink' })} type="button">
                      Change back to Staff…
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm" onClick={() => toggleRole(u)} type="button">
                      {u.role === 'admin' ? 'Admin' : 'Staff'}
                    </button>
                    {u.role === 'staff' && (
                      <button className="btn btn-sm" onClick={() => setAccess({ user: u, mode: 'link' })} type="button">
                        Change to Technician…
                      </button>
                    )}
                  </>
                )}
                <button className="btn btn-sm" onClick={() => resetPassword(u)} type="button">
                  Reset password
                </button>
                <button
                  className="btn btn-sm"
                  disabled={u.id === me.id || isLastActiveAdmin}
                  title={
                    u.id === me.id
                      ? "You can't deactivate your own account."
                      : isLastActiveAdmin
                      ? "You can't deactivate the last active administrator account."
                      : undefined
                  }
                  onClick={() => toggleActive(u)}
                  type="button"
                >
                  {u.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>
          );
        })}
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
        {error && <div className="notice error" style={{ marginBottom: 10 }}>{error}</div>}
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
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
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
