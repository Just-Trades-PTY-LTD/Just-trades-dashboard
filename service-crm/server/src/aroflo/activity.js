// Read-only "AroFlo activity" for the live Technician & Sales form: labour
// logged on a job and its booked visits, reduced to exactly what staff see —
// technician name and position, date, start/finish and hours. Built field by
// field (a whitelist), so staff emails, mobiles, ids and labour rates that
// AroFlo includes in these responses never reach the browser. Display only:
// nothing here is saved or applied to any form field.

// Just Trades' AroFlo business unit is in South Australia.
const LOCAL_TIME_ZONE = 'Australia/Adelaide';

const localParts = new Intl.DateTimeFormat('en-AU', {
  timeZone: LOCAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// AroFlo mixes formats: labour times come back as local time with no offset
// ("2026-10-26T13:58:00"), while /schedules returns UTC ("...T20:30:00.000Z").
// A value carrying a Z or an offset is converted to Adelaide time — reading
// the date straight off a UTC value would put any morning visit on the
// previous day. A value without one is already local and is read as-is.
export function toLocalDateTime(value) {
  if (!value || typeof value !== 'string') return { date: '', time: '' };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) return { date: '', time: '' };
    const p = Object.fromEntries(localParts.formatToParts(instant).map(({ type, value: v }) => [type, v]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  const m = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  return m ? { date: m[1], time: m[2] || '' } : { date: '', time: '' };
}

function personName(person) {
  return [person?.givenName, person?.familyName].filter(Boolean).join(' ').trim();
}

function toHours(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const byDateTime = (a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`);

export function summarizeLabour(items) {
  if (!Array.isArray(items)) return null;
  return items
    .map((item) => {
      const start = toLocalDateTime(item.startTime);
      const finish = toLocalDateTime(item.finishTime);
      return {
        technician: personName(item.user),
        position: item.user?.position || '',
        date: (item.date || '').slice(0, 10) || start.date,
        start: start.time,
        finish: finish.time,
        hours: toHours(item.hours),
      };
    })
    .sort(byDateTime);
}

export function summarizeVisits(items) {
  if (!Array.isArray(items)) return null;
  return items
    .map((item) => {
      const start = toLocalDateTime(item.startTime);
      const finish = toLocalDateTime(item.endTime);
      return {
        technician: personName(item.resource),
        position: item.resource?.position || '',
        date: start.date,
        start: start.time,
        finish: finish.time,
        hours: toHours(item.hours),
      };
    })
    .sort(byDateTime);
}

// AroFlo's invoice statuses before approval (In Progress, Pending Approval —
// per its APIv2 reference) mean the amount can still change. Compared with
// spacing, case and punctuation ignored, since the exact wording AroFlo
// returns hasn't been confirmed on a draft invoice yet.
const DRAFT_STATUSES = new Set(['inprogress', 'pendingapproval', 'draft']);
export function isDraftInvoiceStatus(status) {
  return DRAFT_STATUSES.has(String(status || '').toLowerCase().replace(/[^a-z]/g, ''));
}
