import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { hashPassword } from '../lib/password.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { recordSettingsActivity } from '../lib/settingsActivity.js';

// Placeholder email for a removed account whose email was released for reuse.
const releasedEmail = (id) => `released-${id}@removed.invalid`;
const isReleasedEmail = (email) => /^released-\d+@removed\.invalid$/.test(String(email || ''));

// What an account is linked to: every table referring to users (read from the
// database, so tables added later count too), except its own sign-in
// sessions and saved report layouts. Any Technician-link history counts.
const OWN_ONLY = new Set(['sessions', 'user_report_layouts']);
const LINK_LABELS = {
  calls: 'call',
  jobs: 'job',
  sales: 'sale',
  call_backs: 'Call Back entry',
  pending_cancellations: 'Pending Cancellation',
  audit_log: 'history entry',
  settings_activity: 'Settings Activity entry',
  follow_ups: 'follow-up',
  follow_up_events: 'follow-up note',
  reviews: 'review',
  technician_accounts: 'Technician-link record',
};
export function accountLinks(userId) {
  const counts = new Map();
  for (const t of all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
    if (OWN_ONLY.has(t.name)) continue;
    const cols = all(`PRAGMA foreign_key_list('${t.name}')`).filter((fk) => fk.table === 'users').map((fk) => fk.from);
    if (!cols.length) continue;
    const n = get(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${cols.map((c) => `${c} = ?`).join(' OR ')}`, cols.map(() => userId)).n;
    if (n) counts.set(t.name, n);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const text = [...counts.entries()].map(([t, n]) => `${n} ${LINK_LABELS[t] || t}${n === 1 ? '' : t === 'call_backs' ? '' : 's'}`).join(', ');
  return { total, text };
}

// accessType is 'technician' when the account has an active technician link
// (technician_accounts) — the stored role column is never changed by that.
function activeLink(userId) {
  return get(
    `SELECT ta.*, t.name AS technician_name, t.active AS technician_active
     FROM technician_accounts ta LEFT JOIN technicians t ON t.id = ta.technician_id
     WHERE ta.user_id = ? AND ta.unlinked_at IS NULL`,
    [userId]
  );
}

function publicUser(u) {
  const link = activeLink(u.id);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: !!u.active,
    removed: !!u.removed_at,
    removedAt: u.removed_at || null,
    emailReleased: isReleasedEmail(u.email),
    createdAt: u.created_at,
    accessType: link ? 'technician' : u.role,
    technicianId: link ? link.technician_id : null,
    technicianName: link ? link.technician_name || '(missing technician record)' : null,
    technicianActive: link ? !!link.technician_active : null,
    linkedAt: link ? link.linked_at : null,
  };
}

// What changing this account to Technician would mean, for the admin's
// confirmation — and every reason it isn't allowed. Read-only.
function technicianLinkCheck(user, technicianId) {
  const blockers = [];
  const technician = technicianId ? get('SELECT id, name, active FROM technicians WHERE id = ?', [Number(technicianId)]) : null;
  if (!user) blockers.push('Account not found.');
  else {
    if (user.role === 'admin') blockers.push("Administrator accounts can't be changed to Technician. Change it to Staff first.");
    if (activeLink(user.id)) blockers.push('This account is already a Technician account.');
  }
  if (!technician) blockers.push('Choose an existing technician record.');
  else {
    if (!technician.active) blockers.push(`${technician.name} is inactive. Only an active technician can be linked.`);
    const taken = get(
      `SELECT u.name FROM technician_accounts ta JOIN users u ON u.id = ta.user_id WHERE ta.technician_id = ? AND ta.unlinked_at IS NULL`,
      [technician.id]
    );
    if (taken) blockers.push(`${technician.name} is already linked to ${taken.name}'s account.`);
  }
  const counts = technician
    ? {
        jobs: get('SELECT COUNT(*) AS n FROM jobs WHERE archived = 0 AND technician_id = ?', [technician.id]).n,
        sales: get('SELECT COUNT(*) AS n FROM sales WHERE archived = 0 AND credited_technician_id = ?', [technician.id]).n,
        reviews: get('SELECT COUNT(*) AS n FROM review_technicians WHERE technician_id = ?', [technician.id]).n,
      }
    : null;
  return { technician, counts, blockers };
}

export function createUsersRouter() {
  const router = Router();

  // Any signed-in user can see who to attribute a call to; only admins get
  // emails/roles/full management. Active-only by default — this is the list
  // used to assign new work (e.g. "Handled by"), so a deactivated account
  // must never appear here. Pass ?all=1 for the separate case of a
  // historical filter (Call History, Reports, admin Activity), where a
  // deactivated account's past work still needs to be findable by name.
  router.get('/directory', requireAuth, (req, res) => {
    const sql = req.query.all
      ? "SELECT id, CASE WHEN removed_at IS NOT NULL THEN name || ' (removed)' ELSE name END AS name, active FROM users ORDER BY active DESC, name COLLATE NOCASE"
      : 'SELECT id, name FROM users WHERE active = 1 AND removed_at IS NULL ORDER BY name COLLATE NOCASE';
    res.json(all(sql));
  });

  router.use(requireAdmin);

  router.get('/', (req, res) => {
    res.json(all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').map((u) => ({ ...publicUser(u), links: accountLinks(u.id) })));
  });

  router.post('/', (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const normalizedEmail = String(email).toLowerCase().trim();
    const holder = get('SELECT id, name, removed_at FROM users WHERE email = ?', [normalizedEmail]);
    if (holder) {
      return res.status(409).json({
        error: holder.removed_at
          ? `That email belongs to the removed account "${holder.name}". Restore that account, or release its email first (Removed accounts).`
          : 'A user with that email already exists.',
      });
    }
    const { lastInsertRowid } = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [
      name.trim(),
      normalizedEmail,
      hashPassword(password),
      role === 'admin' ? 'admin' : 'staff',
    ]);
    const created = get('SELECT * FROM users WHERE id = ?', [lastInsertRowid]);
    recordSettingsActivity({ entityType: 'user', entityId: created.id, label: created.name, action: 'added', changes: { type: { from: null, to: created.role === 'admin' ? 'Admin' : 'Staff' } }, user: req.user });
    res.status(201).json(publicUser(created));
  });

  router.patch('/:id', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { name, role, active, password } = req.body || {};
    const newRole = role === undefined ? undefined : role === 'admin' ? 'admin' : 'staff';
    if (user.removed_at) return res.status(400).json({ error: 'This account is removed. Restore it first (Removed accounts). Nothing was changed.' });

    // Every check runs before anything is saved, so a refused request never
    // leaves part of the change applied (e.g. a new name saved alongside a
    // rejected deactivation).
    if (active !== undefined && !active && user.id === req.user.id) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }
    // Deactivating OR demoting the last active administrator would leave
    // nobody able to manage staff accounts or Settings.
    const losesAdmin = user.role === 'admin' && user.active && ((active !== undefined && !active) || newRole === 'staff');
    if (losesAdmin) {
      const { n: activeAdmins } = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
      if (activeAdmins <= 1) {
        return res.status(400).json({
          error: newRole === 'staff'
            ? "You can't change the last active administrator to staff — make another account an administrator first."
            : "You can't deactivate the last active administrator account.",
        });
      }
    }
    if (password && password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (newRole === 'admin' && activeLink(user.id)) {
      return res.status(400).json({ error: 'This is a Technician account. Change it back to Staff before making it an administrator.' });
    }

    transaction(() => {
      if (name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
      if (newRole !== undefined) run('UPDATE users SET role = ? WHERE id = ?', [newRole, user.id]);
      if (active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, user.id]);
      if (password) run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
    });
    const label = name !== undefined && name !== user.name ? name : user.name;
    const log = (action, changes) => recordSettingsActivity({ entityType: 'user', entityId: user.id, label, action, changes, user: req.user });
    if (name !== undefined && name !== user.name) log('renamed', { name: { from: user.name, to: name } });
    if (newRole !== undefined && newRole !== user.role) log('type_changed', { type: { from: user.role === 'admin' ? 'Admin' : 'Staff', to: newRole === 'admin' ? 'Admin' : 'Staff' } });
    if (active !== undefined && !!active !== !!user.active) log(active ? 'activated' : 'deactivated');
    if (password) log('password_reset');
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  // ---- Technician access (admin only, deliberate, one account at a time) ----
  // Changing access never edits the users row (id, email, password, role)
  // or any job/sale/review/history record: it only adds or closes a
  // technician_accounts link, and signs the account out so its next sign-in
  // starts with the new access.
  router.get('/:id/technician-preview', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    const check = technicianLinkCheck(user, req.query.technicianId);
    res.json({ account: user ? publicUser(user) : null, ...check });
  });

  router.post('/:id/technician-link', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Please confirm the change.' });
    if (user.removed_at) return res.status(400).json({ error: 'This account is removed. Restore it first. Nothing was changed.' });
    const { blockers, technician } = technicianLinkCheck(user, req.body?.technicianId);
    if (blockers.length) return res.status(400).json({ error: `${blockers.join(' ')} Nothing was changed.` });
    try {
      transaction(() => {
        run('INSERT INTO technician_accounts (user_id, technician_id, linked_by_user_id) VALUES (?, ?, ?)', [user.id, technician.id, req.user.id]);
        run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
        recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'type_changed', changes: { type: { from: 'Staff', to: `Technician — ${technician.name}` } }, user: req.user });
      });
    } catch (err) {
      // The unique indexes are the final guard against two links racing.
      if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'That account or technician was linked by someone else just now. Nothing was changed.' });
      throw err;
    }
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  router.post('/:id/technician-unlink', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Please confirm the change.' });
    const link = activeLink(user.id);
    if (!link) return res.status(400).json({ error: 'This account is not a Technician account. Nothing was changed.' });
    transaction(() => {
      run("UPDATE technician_accounts SET unlinked_at = datetime('now'), unlinked_by_user_id = ? WHERE id = ?", [req.user.id, link.id]);
      run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'type_changed', changes: { type: { from: `Technician — ${link.technician_name || 'technician'}`, to: 'Staff' } }, user: req.user });
    });
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  // ---- Removing, restoring and deleting accounts (admin only) ----
  // Soft-remove: for an inactive account (whatever it's linked to). It can't
  // sign in while removed; its name and links stay on every record; its
  // email stays reserved; its type and any Technician link are unchanged.
  router.post('/:id/remove', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Please confirm the change.' });
    if (user.id === req.user.id) return res.status(400).json({ error: "You can't remove your own account. Nothing was changed." });
    if (user.removed_at) return res.status(400).json({ error: 'This account is already removed.' });
    if (user.active) return res.status(400).json({ error: 'Deactivate this account before removing it. Nothing was changed.' });
    transaction(() => {
      run("UPDATE users SET removed_at = datetime('now') WHERE id = ?", [user.id]);
      run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'removed', user: req.user });
    });
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  // Restore: back exactly as it was — still inactive (reactivate it and reset
  // the password if needed). A released email needs a new one.
  router.post('/:id/restore', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Please confirm the change.' });
    if (!user.removed_at) return res.status(400).json({ error: 'This account is not removed.' });
    let email = user.email;
    if (isReleasedEmail(user.email)) {
      email = String(req.body?.email || '').toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "This account's email was released — enter a new email to restore it." });
      if (get('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ error: 'That email already belongs to another account.' });
    }
    transaction(() => {
      run('UPDATE users SET removed_at = NULL, email = ? WHERE id = ?', [email, user.id]);
      recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'restored', changes: email !== user.email ? { email: { from: null, to: email } } : {}, user: req.user });
    });
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  // Release a removed account's email so another account can use it. The
  // original email is kept in Settings Activity.
  router.post('/:id/release-email', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Please confirm the change.' });
    if (!user.removed_at) return res.status(400).json({ error: 'Only a removed account can have its email released.' });
    if (isReleasedEmail(user.email)) return res.status(400).json({ error: "This account's email is already released." });
    transaction(() => {
      run('UPDATE users SET email = ? WHERE id = ?', [releasedEmail(user.id), user.id]);
      recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'email_released', changes: { email: { from: user.email, to: null } }, user: req.user });
    });
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  // Permanent delete: only an inactive account linked to nothing at all,
  // after typing its exact name. Its sessions and saved report layouts go
  // with it. The deletion is recorded with its name.
  router.delete('/:id', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account. Nothing was changed." });
    if (user.active) return res.status(400).json({ error: 'Deactivate this account before deleting it. Nothing was changed.' });
    if (String(req.body?.confirmName ?? '').trim() !== user.name) {
      return res.status(400).json({ error: `Type the account name exactly ("${user.name}") to confirm. Nothing was changed.` });
    }
    const links = accountLinks(user.id);
    if (links.total) {
      return res.status(409).json({ error: `This account is linked to ${links.text}, so it can't be permanently deleted — remove it instead (it can be restored). Nothing was changed.` });
    }
    try {
      transaction(() => {
        run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
        run('DELETE FROM user_report_layouts WHERE user_id = ?', [user.id]);
        run('DELETE FROM users WHERE id = ?', [user.id]);
        recordSettingsActivity({ entityType: 'user', entityId: user.id, label: user.name, action: 'deleted', changes: { email: { from: user.email, to: null } }, user: req.user });
      });
    } catch (err) {
      // The database's own links are the final guard.
      if (/FOREIGN KEY/i.test(err.message)) return res.status(409).json({ error: 'This account is linked to records, so it can only be removed. Nothing was changed.' });
      throw err;
    }
    res.json({ ok: true });
  });

  return router;
}
