import { config } from '../config.js';

// Stage 1 test-only client: GET requests exclusively. There is deliberately
// no function here that issues a POST/PUT/PATCH/DELETE to AroFlo — the
// read-only guarantee comes from this file simply never containing a write
// call, not from a runtime check that could be bypassed.

const REQUEST_TIMEOUT_MS = 10_000;

export class ArofloNotConfiguredError extends Error {}
export class ArofloRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
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
    throw new ArofloRequestError(`AroFlo returned an error (${res.status}).`, res.status);
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
async function arofloProbe(path, params = {}) {
  try {
    const body = await arofloGet(path, params);
    return { tried: path, available: true, data: body };
  } catch (err) {
    if (err instanceof ArofloNotConfiguredError) throw err; // not a probe-specific failure
    const status = err instanceof ArofloRequestError ? err.status : 0;
    return { tried: path, available: false, status, note: status === 404 ? 'endpoint not found on this account' : 'request failed' };
  }
}

// Candidate endpoints for information not available on GET /tasks/{id} once
// a task is completed, or not confirmed to exist at all on this account's
// APIv2 — see the Stage 1 test page's own comments for why each is being
// tried. Every path here is a guess based on the task/invoice/businessunit
// naming convention already proven to work; a 404 is a normal, useful
// result (it means that guess doesn't exist on this account), not a bug.
export async function probeTaskHistory(businessUnitId, taskId) {
  const candidates = [
    ['/tasks/' + encodeURIComponent(taskId) + '/timesheets', {}],
    ['/timesheets', { businessUnitId, taskId }],
    ['/tasks/' + encodeURIComponent(taskId) + '/schedules', {}],
    ['/schedules', { businessUnitId, taskId }],
    ['/tasks/' + encodeURIComponent(taskId) + '/history', {}],
    ['/tasks/' + encodeURIComponent(taskId) + '/activity', {}],
  ];
  const results = [];
  for (const [path, params] of candidates) {
    // Sequential, not parallel — this is a small, deliberate, low-volume
    // investigation tool, not something that should ever hammer AroFlo's
    // API with a burst of speculative requests.
    // eslint-disable-next-line no-await-in-loop
    results.push(await arofloProbe(path, params));
  }
  return results;
}

export async function probeLocationDetail(locationId) {
  if (!locationId) return null;
  return arofloProbe('/locations/' + encodeURIComponent(locationId), {});
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
