import { Router } from 'express';
import { get, run } from '../db/index.js';
import { hashPassword, verifyPassword, newToken } from '../lib/password.js';
import { requireAuth, SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { config } from '../config.js';

export function createAuthRouter() {
  const router = Router();

  function cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
    };
  }

  router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase().trim()]);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000).toISOString();
    run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, expiresAt]);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  router.post('/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token) run('DELETE FROM sessions WHERE token = ?', [token]);
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(currentPassword || '', user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), req.user.id]);
    res.json({ ok: true });
  });

  return router;
}
