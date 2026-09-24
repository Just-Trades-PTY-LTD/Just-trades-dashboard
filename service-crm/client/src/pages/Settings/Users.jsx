import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useSettings } from '../../lib/SettingsContext.jsx';

function emptyForm() {
  return { name: '', email: '', password: '', role: 'staff' };
}

export default function Users() {
  const { user: me } = useAuth();
  const { refresh: refreshSettings } = useSettings();
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {u.active ? (
                  <span className="badge badge-success">Active</span>
                ) : (
                  <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--ink-muted)' }}>
                    Inactive
                  </span>
                )}
                <button className="btn btn-sm" onClick={() => toggleRole(u)} type="button">
                  {u.role === 'admin' ? 'Admin' : 'Staff'}
                </button>
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
