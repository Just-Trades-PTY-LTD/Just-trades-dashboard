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
  return { token, user: withAccessType(user) };
}

// An account with an active technician_accounts link is a Technician account,
// whatever its stored role column says (the users table is never changed by
// linking). Re-read on every request, so a link change or a deactivated
// technician takes effect immediately. technicianActive is false when the
// linked technician record is missing or inactive — such an account is
// blocked from all technician data and NEVER falls back to Staff access.
export function withAccessType(user) {
  const link = get('SELECT technician_id FROM technician_accounts WHERE user_id = ? AND unlinked_at IS NULL', [user.id]);
  if (!link) return { ...user, technicianId: null };
  const tech = get('SELECT id, name, active FROM technicians WHERE id = ?', [link.technician_id]);
  return {
    ...user,
    role: 'technician',
    technicianId: link.technician_id,
    technicianName: tech?.name || '',
    technicianActive: !!tech?.active,
  };
}

// Deny-by-default for Technician accounts: every /api route is refused
// (403) except signing in/out, "who am I", changing their own password, their
// own report-layout preferences and the read-only /api/me routes. Anything
// added to the app later is therefore closed to technicians automatically.
const TECHNICIAN_ALLOWED = [
  ['POST', /^\/api\/auth\/(login|logout|change-password)$/],
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/me(\/.*)?$/],
  ['GET', /^\/api\/reports\/layouts$/],
  ['PUT', /^\/api\/reports\/layouts\/[^/]+$/],
];

export function technicianGate(req, res, next) {
  if (!req.user || req.user.role !== 'technician') return next();
  const path = req.originalUrl.split('?')[0];
  if (!path.startsWith('/api/')) return next();
  if (TECHNICIAN_ALLOWED.some(([method, re]) => method === req.method && re.test(path))) return next();
  return res.status(403).json({ error: 'Technician accounts can only use My Performance and My Reviews.' });
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
