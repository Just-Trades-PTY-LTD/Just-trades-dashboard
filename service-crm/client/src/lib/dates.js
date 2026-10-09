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

// "YYYY-MM-DD" for a UTC-anchored Date, shared by every quick-range
// calculation below — all of them do their arithmetic on a plain Y/M/D
// triple via Date.UTC()/getUTCDate() (never a local-time getter), so every
// one of them is correct regardless of which timezone the browser's own
// clock happens to be set to.
function fmtUtcDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The Monday (as a UTC-anchored Date) of the Adelaide-calendar week containing
// the given Y/M/D triple.
function mondayOfAdelaideDate(year, month, day) {
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  const dow = asUtc.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  asUtc.setUTCDate(asUtc.getUTCDate() + mondayOffset);
  return asUtc;
}

// The current Monday–Sunday week, by the Adelaide calendar — used to default
// (and to reset) both reports' date filters, and as the "Current Week" quick
// range option below.
export function currentAdelaideWeek() {
  const p = adelaideNowParts();
  const monday = mondayOfAdelaideDate(Number(p.year), Number(p.month), Number(p.day));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { from: fmtUtcDate(monday), to: fmtUtcDate(sunday) };
}

// The previous Monday–Sunday week, by the Adelaide calendar.
export function lastAdelaideWeek() {
  const p = adelaideNowParts();
  const monday = mondayOfAdelaideDate(Number(p.year), Number(p.month), Number(p.day));
  monday.setUTCDate(monday.getUTCDate() - 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { from: fmtUtcDate(monday), to: fmtUtcDate(sunday) };
}

// The 1st through the last calendar day of the current Adelaide month. Day 0
// of "next month" is JS's own well-defined way of asking for "the last day
// of this month" — it correctly accounts for 28/29/30/31-day months (and
// leap Februaries) with no month-length table of our own to get wrong.
export function currentAdelaideMonth() {
  const p = adelaideNowParts();
  const first = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, 1));
  const last = new Date(Date.UTC(Number(p.year), Number(p.month), 0));
  return { from: fmtUtcDate(first), to: fmtUtcDate(last) };
}

// The 1st through the last calendar day of the previous Adelaide month —
// Date.UTC() itself rolls month -1 in January back into December of the
// previous year, so no special-cased year-boundary logic is needed here.
export function lastAdelaideMonth() {
  const p = adelaideNowParts();
  const first = new Date(Date.UTC(Number(p.year), Number(p.month) - 2, 1));
  const last = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, 0));
  return { from: fmtUtcDate(first), to: fmtUtcDate(last) };
}

// The Reports page's quick date-range picker — selecting one of the first
// four immediately fills in the existing From/To fields (via each preset's
// own range() above); "Custom Range" is deliberately inert (range: null) —
// it's shown automatically whenever the current From/To don't exactly match
// any computed preset, and selecting it explicitly is a no-op, leaving
// whatever's already in From/To for the user to edit freely.
export const DATE_RANGE_PRESETS = [
  { id: 'current_week', name: 'Current Week', range: currentAdelaideWeek },
  { id: 'last_week', name: 'Last Week', range: lastAdelaideWeek },
  { id: 'current_month', name: 'Current Month', range: currentAdelaideMonth },
  { id: 'last_month', name: 'Last Month', range: lastAdelaideMonth },
  { id: 'custom', name: 'Custom Range', range: null },
];

// Which preset (if any) the given From/To exactly matches right now — used
// purely to decide what the quick-range dropdown itself should show as
// currently selected; never changes From/To on its own.
export function matchDateRangePreset(from, to) {
  const hit = DATE_RANGE_PRESETS.find((p) => p.range && (() => {
    const r = p.range();
    return r.from === from && r.to === to;
  })());
  return hit ? hit.id : 'custom';
}

// Display formatting only — never rounds the value anywhere it's stored or
// calculated from; cents are preserved (standard rounding to 2 decimal
// places, via toLocaleString's own fraction-digit rounding) rather than
// dropped, and every amount always shows both decimal places (e.g. $374.00)
// so whole-dollar and cents amounts read consistently.
export function money(v) {
  return `$${(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
