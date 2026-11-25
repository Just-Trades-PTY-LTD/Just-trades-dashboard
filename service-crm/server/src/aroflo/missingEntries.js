import { all } from '../db/index.js';
import { countArofloCalls, listBusinessUnits, listTaskLabours, listTasksPage, probeListing } from './client.js';
import { toLocalDateTime } from './activity.js';
import { asText } from './values.js';

// Missing entries check — READ-ONLY TEST (admin only, Reports).
//
// For a date range: which AroFlo Job Numbers had labour logged by an active
// CRM field technician, and is each Job Number already accounted for in the
// CRM? Job Numbers, not visits: a Job Number with several visits is listed
// once. Accounted for = a New Job entry (jobs), a Call Back (original or new
// Job Number), or an approved-quote install (an active Quote Approved Later
// sale's New Job Number, follow-ons included).
//
// GET requests to AroFlo only; SELECTs on the CRM only. Nothing is saved,
// changed or created anywhere. It also tries a few date filters on AroFlo's
// list endpoints and reports which (if any) AroFlo honours, and how many
// requests each approach used — that decides how the real check is built.

export const MAX_RANGE_DAYS = 31;
const LOOKBACK_DAYS = 60; // jobs created up to this long before the range can still have labour in it
const MAX_TASK_PAGES = 10; // 1,000 newest jobs at most
const MAX_LABOUR_REQUESTS = 300;
const TASK_FIELDS = 'id,jobNumber,status,taskType,completionDate,timestampCreated,location';

const norm = (v) => String(v ?? '').trim().toLowerCase();
const day = (v) => toLocalDateTime(asText(v)).date;
const addDays = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const personName = (p) => [asText(p?.givenName), asText(p?.familyName)].filter(Boolean).join(' ').trim();

/** CRM Job Numbers already accounted for, with what they matched. */
export function crmAccountedJobNumbers() {
  const map = new Map();
  const add = (jn, how) => {
    const k = norm(jn);
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(how);
  };
  all('SELECT job_number FROM jobs WHERE archived = 0').forEach((r) => add(r.job_number, 'New Job entry'));
  all('SELECT job_number, new_job_number FROM call_backs WHERE archived = 0').forEach((r) => {
    add(r.job_number, 'Call Back (original job)');
    add(r.new_job_number, 'Call Back');
  });
  all("SELECT new_job_number FROM sales WHERE archived = 0 AND source = 'quote_approved_later' AND is_upsell = 0").forEach((r) =>
    add(r.new_job_number, 'Approved-quote install')
  );
  return map;
}

/** The active CRM technician an AroFlo name belongs to: the CRM name must
 * appear in full in the AroFlo name, and only one may match. */
export function technicianMatcher() {
  const techs = all('SELECT id, name FROM technicians WHERE active = 1').filter((t) => norm(t.name));
  return (arofloName) => {
    const hay = norm(arofloName);
    if (!hay) return null;
    const m = techs.filter((t) => hay.includes(norm(t.name)));
    return m.length === 1 ? m[0] : null;
  };
}

// Candidate business-wide date filters — guesses, since AroFlo's reference
// doesn't list date filters for these. One request each.
function dateFilterCandidates(bu, from, to) {
  return [
    ['/labours', { businessUnitId: bu, startDate: from, endDate: to, limit: 100 }, 'labours: startDate/endDate', 'labour'],
    ['/labours', { businessUnitId: bu, dateFrom: from, dateTo: to, limit: 100 }, 'labours: dateFrom/dateTo', 'labour'],
    ['/labours', { businessUnitId: bu, fromDate: from, toDate: to, limit: 100 }, 'labours: fromDate/toDate', 'labour'],
    ['/timesheets', { businessUnitId: bu, startDate: from, endDate: to, limit: 100 }, 'timesheets: startDate/endDate', 'labour'],
    ['/schedules', { businessUnitId: bu, startDate: from, endDate: to, limit: 100 }, 'schedules: startDate/endDate', 'schedule'],
    ['/schedules', { businessUnitId: bu, scheduleZone: 'TASK', startDate: from, endDate: to, limit: 100 }, 'schedules (TASK): startDate/endDate', 'schedule'],
    ['/tasks', { businessUnitId: bu, completionDateFrom: from, completionDateTo: to, limit: 100, _fields: 'id,jobNumber,completionDate' }, 'tasks: completionDateFrom/To', 'task'],
  ];
}

function itemDate(kind, item) {
  if (kind === 'labour') return asText(item.date).slice(0, 10) || day(item.startTime);
  if (kind === 'schedule') return day(item.startTime);
  return day(item.completionDate);
}

// Only counts and dates are kept from these probes — never the raw items
// (they include staff details and labour rates).
function evaluateProbe(res, kind, from, to) {
  if (!res.available) {
    return { available: false, status: res.status, note: res.note, aroflo: res.detail ? JSON.stringify(res.detail).slice(0, 300) : null };
  }
  const items = Array.isArray(res.data?.items) ? res.data.items : [];
  const dates = items.map((i) => itemDate(kind, i)).filter(Boolean).sort();
  const inside = dates.filter((d) => inRange(d, from, to)).length;
  return {
    available: true,
    returned: items.length,
    reportedCount: Number.isFinite(Number(res.data?.count)) ? Number(res.data.count) : null,
    datedItems: dates.length,
    insideRange: inside,
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
    // Honoured only if it returned dated items and every one is in range.
    filterHonoured: dates.length > 0 && inside === dates.length,
  };
}

export async function runMissingEntriesTest({ from, to }) {
  const started = Date.now();
  const bu = (await listBusinessUnits())[0];
  if (!bu) return { error: 'No AroFlo business unit found.' };

  // 1. Date filters AroFlo might honour.
  const filterTests = [];
  const { calls: filterCalls } = await countArofloCalls(async () => {
    for (const [path, params, label, kind] of dateFilterCandidates(bu.id, from, to)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await probeListing(path, params, label);
      filterTests.push({ label, ...evaluateProbe(res, kind, from, to) });
    }
  });

  // 2. Fallback that always works: newest jobs first, then each candidate
  // job's labour.
  const earliestCreated = addDays(from, -LOOKBACK_DAYS);
  const tasks = [];
  let taskPages = 0;
  let pagesCapped = false;
  const { calls: taskCalls } = await countArofloCalls(async () => {
    for (let page = 1; page <= MAX_TASK_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const items = await listTasksPage(bu.id, page, TASK_FIELDS);
      taskPages += 1;
      tasks.push(...items);
      const created = items.map((t) => day(t.timestampCreated)).filter(Boolean).sort();
      if (items.length < 100 || (created.length && created[0] < earliestCreated)) return;
      if (page === MAX_TASK_PAGES) pagesCapped = true;
    }
  });
  const candidates = tasks.filter((t) => {
    const created = day(t.timestampCreated);
    const completed = day(t.completionDate);
    if (created && created > to) return false; // created after the range
    if (created && created < earliestCreated) return false; // outside the look-back
    if (completed && completed < from) return false; // finished before the range
    return true;
  });

  const matchTech = technicianMatcher();
  const unmatchedNames = new Map();
  const byJn = new Map();
  let labourRequests = 0;
  let labourCapped = false;
  let labourUnavailable = 0;
  const { calls: labourCalls } = await countArofloCalls(async () => {
    for (const t of candidates) {
      if (labourRequests >= MAX_LABOUR_REQUESTS) {
        labourCapped = true;
        break;
      }
      labourRequests += 1;
      // eslint-disable-next-line no-await-in-loop
      const labours = await listTaskLabours(t.id);
      if (labours === null) {
        labourUnavailable += 1;
        continue;
      }
      for (const l of labours) {
        const d = asText(l.date).slice(0, 10) || day(l.startTime);
        if (!inRange(d, from, to)) continue;
        const name = personName(l.user);
        const tech = matchTech(name);
        if (!tech) {
          if (name) unmatchedNames.set(name, (unmatchedNames.get(name) || 0) + 1);
          continue;
        }
        const jn = asText(t.jobNumber);
        if (!byJn.has(jn)) {
          byJn.set(jn, {
            jobNumber: jn,
            status: asText(t.status),
            taskType: asText(t.taskType?.name) || asText(t.taskType),
            suburb: asText(t.location?.suburb),
            completed: day(t.completionDate),
            technicians: new Set(),
            dates: new Set(),
          });
        }
        byJn.get(jn).technicians.add(tech.name);
        byJn.get(jn).dates.add(d);
      }
    }
  });

  // 3. Compare de-duplicated Job Numbers with the CRM.
  const accounted = crmAccountedJobNumbers();
  const jobs = [...byJn.values()]
    .map((j) => ({
      ...j,
      technicians: [...j.technicians].sort(),
      dates: [...j.dates].sort(),
      visits: j.dates.size,
      accountedFor: accounted.has(norm(j.jobNumber)) ? [...accounted.get(norm(j.jobNumber))] : [],
    }))
    .sort((a, b) => Number(a.jobNumber) - Number(b.jobNumber) || a.jobNumber.localeCompare(b.jobNumber));
  const missing = jobs.filter((j) => !j.accountedFor.length);

  return {
    from,
    to,
    summary: { jobNumbers: jobs.length, accountedFor: jobs.length - missing.length, missing: missing.length },
    jobs,
    unmatchedLabourNames: [...unmatchedNames.entries()].map(([name, entries]) => ({ name, entries })).sort((a, b) => b.entries - a.entries),
    method: {
      dateFilterTests: filterTests,
      dateFilterRequests: filterCalls,
      taskPages,
      taskRequests: taskCalls,
      tasksRead: tasks.length,
      pagesCapped,
      lookbackDays: LOOKBACK_DAYS,
      candidateJobs: candidates.length,
      labourRequests: labourCalls,
      labourCapped,
      labourUnavailable,
      totalRequests: 1 + filterCalls + taskCalls + labourCalls,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    },
  };
}
