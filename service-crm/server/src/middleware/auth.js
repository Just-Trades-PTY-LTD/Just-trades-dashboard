import { get, run } from '../db/index.js';

const COOKIE_NAME = 'crm_session';

export function currentSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const session = get('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  const user = get('SELECT id, name, email, role, active FROM users WHERE id = ?', [session.user_id]);
  if (!user || !user.active) return null;
  return { token, user };
}

export function attachUser(req, res, next) {
  const session = currentSession(req);
  req.user = session ? session.user : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
