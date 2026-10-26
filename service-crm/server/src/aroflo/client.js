import { config } from '../config.js';

// Stage 1 test-only client: GET requests exclusively. There is deliberately
// no function here that issues a POST/PUT/PATCH/DELETE to AroFlo — the
// read-only guarantee comes from this file simply never containing a write
// call, not from a runtime check that could be bypassed.

const REQUEST_TIMEOUT_MS = 10_000;

export class ArofloNotConfiguredError extends Error {}
export class ArofloRequestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    // AroFlo's own error response body, if any and if it parsed as JSON —
    // e.g. a validation message explaining exactly what a 400 wants. Only
    // ever AroFlo's own text, but still redacted below as a hard guarantee
    // our own token can never appear in it (e.g. if AroFlo ever echoed back
    // part of the request in a diagnostic message).
    this.body = body ?? null;
  }
}

// Defence in depth: strips the literal token value out of anything before it
// can reach a log, a thrown error, or this test page — even AroFlo's own
// response body, on the off chance it ever echoed part of the request back
// in a diagnostic message.
function redactToken(value) {
  if (value === null || value === undefined) return value;
  const token = config.aroflo.apiToken;
  if (!token) return value;
  const serialized = JSON.stringify(value);
  if (!serialized.includes(token)) return value;
  const redacted = serialized.split(token).join('[REDACTED]');
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

async function arofloGet(path, params = {}) {
  if (!config.aroflo.apiToken) {
    throw new ArofloNotConfiguredError('AroFlo is not configured on this server (AROFLO_PAT is not set).');
  }
  const url = new URL(`${config.aroflo.baseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.aroflo.apiToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    // Never log/include the raw error (could echo request details) — only a
    // clean, constructed message makes it into logs or the thrown error.
    const reason = err.name === 'AbortError' ? 'timed out' : 'could not be reached';
    throw new ArofloRequestError(`AroFlo ${reason}.`, 0);
  } finally {
    clearTimeout(timeout);
  }

  let body = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    throw new ArofloRequestError(`AroFlo returned an error (${res.status}).`, res.status, redactToken(body));
  }
  return body;
}

// ---- Business Unit Management ----
// There is only ever one business unit on this account ("Just Trades PTY
// LTD" at the time this was built) — this resolves its id by name rather
// than hardcoding it, so it keeps working even if that ever changes.
export async function listBusinessUnits() {
  const body = await arofloGet('/businessunits', { limit: 100 });
  return body?.items || [];
}

// ---- Task Management ----
// There is no job-number filter on the list endpoint, so this pages through
// every task (no status filter applied, so archived/older jobs are never
// excluded up front) and scans client-side for an exact jobNumber match.
const MAX_LIST_PAGES = 25;
const LIST_PAGE_SIZE = 100;

export async function findTaskByJobNumber(businessUnitId, jobNumber) {
  const target = Number(jobNumber);
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const body = await arofloGet('/tasks', { businessUnitId, page, limit: LIST_PAGE_SIZE });
    const items = body?.items || [];
    const match = items.find((item) => Number(item.jobNumber) === target);
    if (match) return match;
    if (items.length < LIST_PAGE_SIZE) break; // last page
  }
  return null;
}

export async function getTaskDetail(taskId) {
  return arofloGet(`/tasks/${encodeURIComponent(taskId)}`);
}

// ---- Invoicing ----
export async function getInvoicesForTask(businessUnitId, taskId) {
  const invoices = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const body = await arofloGet('/invoices', { businessUnitId, taskId, allStatus: 1, page, limit: 100 });
    const items = body?.items || [];
    invoices.push(...items);
    if (items.length < 100) break;
  }
  return invoices;
}

// ---- Stage 1 investigation probes ----
// Unlike arofloGet() above, these never throw on a 404/error — an
// unconfirmed endpoint name is an expected, informative outcome here (it
// tells us the guess was wrong), not a failure that should break the rest
// of the lookup. Still GET-only, still never logs/exposes the token or the
// raw underlying error — same sanitization as arofloGet(), just returned
// instead of thrown so the caller can show "not available on this account"
// next to whatever did work.
// `label` is purely for display when more than one probe shares the same
// `path` but with different params (e.g. several scheduleZone guesses
// against /schedules) — the actual request always uses `path`+`params`.
async function arofloProbe(path, params = {}, label = path) {
  try {
    const body = await arofloGet(path, params);
    return { tried: label, available: true, data: body };
  } catch (err) {
    if (err instanceof ArofloNotConfiguredError) throw err; // not a probe-specific failure
    const status = err instanceof ArofloRequestError ? err.status : 0;
    // A 404 means the endpoint name itself doesn't exist here — nothing more
    // to learn. Any other status (e.g. a 400) means AroFlo recognised the
    // path but rejected this request shape, so AroFlo's own response body
    // (already redacted of the token in arofloGet) is worth surfacing
    // verbatim — it's often a validation message naming the actual
    // parameter this guess got wrong.
    const detail = err instanceof ArofloRequestError ? err.body : null;
    return {
      tried: label,
      available: false,
      status,
      note: status === 404 ? 'endpoint not found on this account' : 'request failed',
      detail,
    };
  }
}

// Candidate endpoints for information not available on GET /tasks/{id} once
// a task is completed, or not confirmed to exist at all on this account's
// APIv2 — see the Stage 1 test page's own comments for why each is being
// tried. Every path here is a guess based on the task/invoice/businessunit
// naming convention already proven to work; a 404 is a normal, useful
// result (it means that guess doesn't exist on this account), not a bug.
export async function probeTaskHistory(businessUnitId, taskId) {
  // A real account's own response to the plain /schedules guess named the
  // exact field it wanted, then named its valid values once a wrong one was
  // tried ("Invalid scheduleZone. Valid values are: TASK, USER" — a scope
  // selector, not a geographic zone), then named the NEXT missing field for
  // each scope in turn: TASK wants a zoneId (valid values unknown — every
  // listing endpoint guess tried via listScheduleZones below came back 404,
  // so businessUnitId is tried here purely because it's the only id-shaped
  // value already in hand, not because it's expected to be right), and USER
  // wants a currentDate (today's date — an actual value, not a guess, to
  // see what field is still missing after it).
  const todayIso = new Date().toISOString().slice(0, 10);
  const candidates = [
    ['/tasks/' + encodeURIComponent(taskId) + '/timesheets', {}],
    ['/timesheets', { businessUnitId, taskId }],
    ['/tasks/' + encodeURIComponent(taskId) + '/schedules', {}],
    ['/schedules', { businessUnitId, taskId }],
    ['/schedules', { businessUnitId, taskId, scheduleZone: 'TASK' }, "/schedules (scheduleZone='TASK')"],
    [
      '/schedules',
      { businessUnitId, taskId, scheduleZone: 'TASK', zoneId: businessUnitId },
      "/schedules (scheduleZone='TASK', zoneId=businessUnitId)",
    ],
    ['/schedules', { businessUnitId, taskId, scheduleZone: 'USER' }, "/schedules (scheduleZone='USER')"],
    [
      '/schedules',
      { businessUnitId, taskId, scheduleZone: 'USER', currentDate: todayIso },
      "/schedules (scheduleZone='USER', currentDate='" + todayIso + "')",
    ],
    ['/tasks/' + encodeURIComponent(taskId) + '/history', {}],
    ['/tasks/' + encodeURIComponent(taskId) + '/activity', {}],
  ];
  const results = [];
  for (const [path, params, label] of candidates) {
    // Sequential, not parallel — this is a small, deliberate, low-volume
    // investigation tool, not something that should ever hammer AroFlo's
    // API with a burst of speculative requests.
    // eslint-disable-next-line no-await-in-loop
    results.push(await arofloProbe(path, params, label));
  }
  return results;
}

// Discovering valid scheduleZone values properly, rather than guessing —
// tries a few plausible names for a zones listing endpoint. If any of these
// comes back available, its data is the real list of valid scheduleZone
// values to use above instead of the two blind guesses.
export async function listScheduleZones(businessUnitId) {
  const candidates = [
    ['/schedulezones', { businessUnitId, limit: 100 }],
    ['/schedule-zones', { businessUnitId, limit: 100 }],
    ['/zones', { businessUnitId, limit: 100 }],
  ];
  const results = [];
  for (const [path, params] of candidates) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await arofloProbe(path, params));
  }
  return results;
}

export async function probeLocationDetail(locationId) {
  if (!locationId) return null;
  return arofloProbe('/locations/' + encodeURIComponent(locationId), {});
}

// Custom fields (e.g. "Lead Source", "Occupant") have shown up in AroFlo's
// own task UI but never once in GET /tasks/{id}'s own response across every
// job tested — so this is either a separate endpoint or needs an extra
// parameter to include them, not a guess at a field name within the
// existing payload. Every candidate here is a guess at how that might be
// requested; a 404 is a normal, informative result, same as every other
// probe in this file.
export async function probeCustomFields(businessUnitId, taskId) {
  const candidates = [
    ['/tasks/' + encodeURIComponent(taskId), { includeCustomFields: 1 }, "/tasks/{id} (includeCustomFields=1)"],
    ['/tasks/' + encodeURIComponent(taskId), { customfields: 1 }, '/tasks/{id} (customfields=1)'],
    ['/tasks/' + encodeURIComponent(taskId) + '/customfields', {}],
    ['/customfields', { businessUnitId, taskId }],
    ['/customfields', { businessUnitId }, '/customfields (no taskId — field definitions only)'],
  ];
  const results = [];
  for (const [path, params, label] of candidates) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await arofloProbe(path, params, label));
  }
  return results;
}

// ---- Business-unit-wide reference listings (for future Trade/Job Type and
// Suburb mapping tables — never auto-applied, just surfaced for review) ----
export async function listTaskTypes(businessUnitId) {
  return arofloProbe('/tasktypes', { businessUnitId, limit: 100 });
}

export async function listLocations(businessUnitId) {
  return arofloProbe('/locations', { businessUnitId, limit: 100 });
}

export async function listAroFloUsers(businessUnitId) {
  return arofloProbe('/users', { businessUnitId, limit: 100 });
}
