// This is an Adelaide-based business. Every stored date/time string (call_at,
// visit_date, invoice_date, date_logged, ...) is a plain "YYYY-MM-DD[THH:mm]"
// value with no timezone marker — it was always saved from the browser's own
// local clock, and every user is physically in Adelaide, so that string
// already *is* Adelaide wall-clock time. Nothing here reinterprets or
// converts a saved value; reading its embedded year/month/day/hour is
// correct as-is and always has been.
//
// The one place this file matters is calendar arithmetic that needs to know
// which real-world day something falls on — e.g. "which Monday does this
// date belong to" for weekly report bucketing. That must not depend on the
// server process's own runtime timezone (this container runs in UTC, but a
// future deploy could run anywhere) — so day-of-week is always computed via
// Date.UTC()/getUTCDay() on the parsed Y/M/D triple, never a local-time
// getter, which makes it correct regardless of where the process runs.
export const ADELAIDE_TZ = 'Australia/Adelaide';

// Day-of-week (0=Sunday..6=Saturday) for a "YYYY-MM-DD..." date string,
// independent of the server process's own timezone.
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// The Monday of the same week as a "YYYY-MM-DD..." date string, formatted as
// "YYYY-MM-DD" — again independent of the server's own timezone.
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  const dow = asUtc.getUTCDay();
  asUtc.setUTCDate(asUtc.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  const pad = (n) => String(n).padStart(2, '0');
  return `${asUtc.getUTCFullYear()}-${pad(asUtc.getUTCMonth() + 1)}-${pad(asUtc.getUTCDate())}`;
}

// A "Generated: ..." label for exported workbooks, in Adelaide local time —
// this is the one place the CRM displays "the current moment" server-side,
// so it's pinned to Australia/Adelaide explicitly rather than the container's
// own (UTC) clock.
export function adelaideGeneratedAtLabel(date = new Date()) {
  return date.toLocaleString('en-AU', { timeZone: ADELAIDE_TZ, dateStyle: 'medium', timeStyle: 'short' });
}

// "YYYY-MM-DD" for the current moment in Adelaide local time — used for
// export filenames, so "today's date" in a downloaded file always matches
// the Adelaide-based user's own calendar date, regardless of which timezone
// the server process itself happens to run in (en-CA formats y-m-d).
export function adelaideDateStamp(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: ADELAIDE_TZ });
}

// Converts a SQLite `datetime('now')`-produced UTC string ("YYYY-MM-DD
// HH:MM:SS") to an Adelaide-local display string. Unlike every *business*
// date/time this CRM stores (call_at, visit_date, invoice_date, ...), which
// are already Adelaide wall-clock strings captured straight from the
// browser's own clock (see the file-level comment above), every table's own
// created_at/updated_at and audit_log.changed_at are stamped by the SQLite
// server process itself via datetime('now') — genuinely UTC — so these, and
// only these, need an actual timezone conversion before being shown to a
// user. Returns '' for a blank input, and the raw string back (rather than
// throwing or showing "Invalid Date") if it's ever something unparseable.
export function utcToAdelaideDisplay(utcString) {
  if (!utcString) return '';
  // SQLite's datetime('now') has no timezone marker; appending 'Z' (after
  // swapping in the 'T' ISO needs) tells Date() to parse it as UTC rather
  // than whichever local timezone the server process itself happens to run
  // in (this one runs in UTC anyway, but must never depend on that).
  const iso = `${utcString.trim().replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return utcString;
  return d.toLocaleString('en-AU', { timeZone: ADELAIDE_TZ, dateStyle: 'medium', timeStyle: 'short' });
}
