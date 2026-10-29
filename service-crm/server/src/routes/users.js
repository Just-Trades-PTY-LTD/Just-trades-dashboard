import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { hashPassword } from '../lib/password.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, createdAt: u.created_at };
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
      ? 'SELECT id, name, active FROM users ORDER BY active DESC, name COLLATE NOCASE'
      : 'SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE';
    res.json(all(sql));
  });

  router.use(requireAdmin);

  router.get('/', (req, res) => {
    res.json(all('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').map(publicUser));
  });

  router.post('/', (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (get('SELECT id FROM users WHERE email = ?', [normalizedEmail])) {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    const { lastInsertRowid } = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [
      name.trim(),
      normalizedEmail,
      hashPassword(password),
      role === 'admin' ? 'admin' : 'staff',
    ]);
    res.status(201).json(publicUser(get('SELECT * FROM users WHERE id = ?', [lastInsertRowid])));
  });

  router.patch('/:id', (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { name, role, active, password } = req.body || {};
    const newRole = role === undefined ? undefined : role === 'admin' ? 'admin' : 'staff';

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

    transaction(() => {
      if (name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
      if (newRole !== undefined) run('UPDATE users SET role = ? WHERE id = ?', [newRole, user.id]);
      if (active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, user.id]);
      if (password) run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
    });
    res.json(publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])));
  });

  return router;
}
