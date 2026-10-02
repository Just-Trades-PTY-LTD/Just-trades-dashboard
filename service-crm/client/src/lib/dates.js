// This is an Adelaide-based business — every "now"/"today" the CRM computes
// (a new record's default Date & time, a report's default date range) is
// pinned to Australia/Adelaide explicitly, via Intl's IANA timezone database,
// rather than trusting the browser/device's own clock/timezone setting. That
// database already knows the ACST/ACDT daylight-saving switchover dates, so
// this keeps working correctly across the DST transition with no manual
// offset math. This does not change what any *saved* record means — a call
// logged last month still shows the exact date/time it was saved with; only
// "what does 'now' mean right now" is computed this way.
const ADELAIDE_TZ = 'Australia/Adelaide';

function pad(n) {
  return String(n).padStart(2, '0');
}

// {year,month,day,hour,minute} of the current instant, as they read on an
// Adelaide wall clock right now.
function adelaideNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ADELAIDE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // A 24-hour formatter can render midnight as "24" in some engines — treat
  // it as 0 rather than let it leak into an invalid "24:xx" string.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

export function nowLocalDateTime() {
  const p = adelaideNowParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function todayLocalDate() {
  const p = adelaideNowParts();
  return `${p.year}-${p.month}-${p.day}`;
}

// The current Monday–Sunday week, by the Adelaide calendar — used to default
// (and to reset) both reports' date filters. Day-of-week is computed via
// Date.UTC()/getUTCDay() on the plain Y/M/D triple rather than a local-time
// getter, so this is correct regardless of which timezone the browser's own
// clock happens to be set to.
export function currentAdelaideWeek() {
  const p = adelaideNowParts();
  const asUtc = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const dow = asUtc.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(asUtc);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: fmt(monday), to: fmt(sunday) };
}

// Display formatting only — never rounds the value anywhere it's stored or
// calculated from; cents are preserved (standard rounding to 2 decimal
// places, via toLocaleString's own fraction-digit rounding) rather than
// dropped, and every amount always shows both decimal places (e.g. $374.00)
// so whole-dollar and cents amounts read consistently.
export function money(v) {
  return `$${(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
