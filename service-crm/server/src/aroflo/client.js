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
// AroFlo's documented `sortBy=jobnumber` with `ascending=false` puts the
// newest jobs first, so a recent JN is normally found on page 1 instead of
// near the end — this matters because the account is capped at 5,000
// requests a day. Once a page that really is in descending order ends
// below the target, the target can't appear on any later page, so paging
// stops there. That early stop is only taken when the page's own order
// proves the sort was applied, so if AroFlo ever ignored sortBy this falls
// back to the original full scan rather than missing a job.
const MAX_LIST_PAGES = 25;
const LIST_PAGE_SIZE = 100;

function isDescendingByJobNumber(items) {
  for (let i = 1; i < items.length; i += 1) {
    if (Number(items[i].jobNumber) > Number(items[i - 1].jobNumber)) return false;
  }
  return true;
}

export async function findTaskByJobNumber(businessUnitId, jobNumber) {
  const target = Number(jobNumber);
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const body = await arofloGet('/tasks', {
      businessUnitId,
      sortBy: 'jobnumber',
      ascending: 'false',
      page,
      limit: LIST_PAGE_SIZE,
    });
    const items = body?.items || [];
    const match = items.find((item) => Number(item.jobNumber) === target);
    if (match) return match;
    if (items.length < LIST_PAGE_SIZE) break; // last page
    const lowest = Number(items[items.length - 1].jobNumber);
    if (lowest < target && isDescendingByJobNumber(items)) break; // already past it
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

// Who worked on / is booked for a task — the three read-only endpoints
// AroFlo's own APIv2 reference documents for this (docs.api.aroflo.com),
// replacing the earlier guesses (/timesheets, /tasks/{id}/history, etc.)
// that only ever 404'd. GET /tasks/{id} itself can't answer this for a
// completed job: per the same docs, its `schedule` is only ever the NEXT
// upcoming visit, so it's empty once the work is done.
// - labours: the time actually logged on the job (who, which day, hours).
// - schedules: every booked visit; scheduleZone=TASK wants the task's own
//   id as zoneId (the earlier probe sent the business unit's id instead).
// - resources: who's assigned, each with AroFlo's own user id.
// Labour entries carry pay/charge rates the CRM never needs — they're
// stripped before anything is returned (see withoutRates below).
export async function probeTaskHistory(businessUnitId, taskId) {
  const id = encodeURIComponent(taskId);
  const candidates = [
    ['/tasks/' + id + '/labours', { limit: 100 }, '/tasks/{taskId}/labours'],
    ['/schedules', { scheduleZone: 'TASK', zoneId: taskId, businessUnitId }, "/schedules (scheduleZone='TASK', zoneId={taskId})"],
    ['/tasks/' + id + '/resources', {}, '/tasks/{taskId}/resources'],
  ];
  const results = [];
  for (const [path, params, label] of candidates) {
    // Sequential, not parallel — a small, deliberate, low-volume
    // investigation tool that should never burst requests at AroFlo.
    // eslint-disable-next-line no-await-in-loop
    const result = await arofloProbe(path, params, label);
    results.push(result.available ? { ...result, data: withoutRates(result.data) } : result);
  }
  return results;
}

// Removes every costRate/sellRate/quoteRate field, at any depth, from a
// probe's data. Labour entries (and the work type / overhead nested inside
// them) carry these whenever the token's AroFlo user is allowed to see
// them; the CRM has no use for pay or charge rates, so they never reach the
// test page.
const RATE_KEYS = new Set(['costRate', 'sellRate', 'quoteRate']);
export function withoutRates(value) {
  if (Array.isArray(value)) return value.map(withoutRates);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !RATE_KEYS.has(key))
      .map(([key, v]) => [key, withoutRates(v)]),
  );
}

export async function probeLocationDetail(locationId) {
  if (!locationId) return null;
  return arofloProbe('/locations/' + encodeURIComponent(locationId), {});
}

// A task's `client` reference (the customer record) only ever showed up in
// the full task detail once — a genuinely new lead, not a blind guess: a
// property like "Lead Source" is often tracked once per customer in a
// field-service system, not per job, so it's worth checking whether AroFlo
// exposes custom fields there instead of on the task itself.
export async function probeClientDetail(clientId) {
  if (!clientId) return null;
  return arofloProbe('/clients/' + encodeURIComponent(clientId), {});
}

// Custom fields (e.g. "Lead Source", "Occupant") have shown up in AroFlo's
// own task UI but never once in GET /tasks/{id}'s own response, and five
// earlier query-param guesses here all either 404'd or were silently
// ignored. AroFlo's own API documentation ("List custom fields for a zone
// and entity") confirms the real shape is path-based, not query-param
// based: GET /customfields/:zone/:id, where zone is one of a fixed enum
// (TASKS, CLIENTS, LOCATIONS, etc.) and id is that entity's own id. Tried
// here for the TASKS zone (the task itself) and, when a client id is known,
// the CLIENTS zone too — Lead Source may be tracked per-customer rather
// than per-job.
export async function probeCustomFields(taskId, clientId) {
  const results = [];
  results.push(
    await arofloProbe('/customfields/TASKS/' + encodeURIComponent(taskId), {}, '/customfields/TASKS/{taskId}'),
  );
  if (clientId) {
    results.push(
      await arofloProbe('/customfields/CLIENTS/' + encodeURIComponent(clientId), {}, '/customfields/CLIENTS/{clientId}'),
    );
  }
  return results;
}

// ---- Production custom-field value lookup ----
// Unlike probeCustomFields() above (which reports every zone's raw result
// for admin investigation), this is for the real, non-admin lookup routes:
// it returns one named field's value directly, or null whenever the zone,
// the entity, or that particular field isn't available — never throws, same
// "a lookup problem never blocks manual entry" contract as arofloProbe().
// A real account's response nests each field directly under `items` (e.g.
// `items[0].customField.name`); this also checks a nested `items[].fields[]`
// in case another zone ever shapes it like AroFlo's own documentation shows
// instead, so either response shape is read correctly.
export async function getCustomFieldValue(zone, id, fieldName) {
  if (!id) return null;
  let body;
  try {
    body = await arofloGet(`/customfields/${zone}/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
  const target = fieldName.toLowerCase();
  for (const item of body?.items || []) {
    const entries = Array.isArray(item.fields) ? item.fields : [item];
    for (const entry of entries) {
      if ((entry.customField?.name || '').toLowerCase() === target) {
        return entry.customField.value ?? null;
      }
    }
  }
  return null;
}

// ---- Business-unit-wide reference listings (for future Trade/Job Type and
// Suburb mapping tables — never auto-applied, just surfaced for review) ----
export async function listTaskTypes(businessUnitId) {
  return arofloProbe('/types/tasks', { businessUnitId, limit: 100 });
}

export async function listLocations(businessUnitId) {
  return arofloProbe('/locations', { businessUnitId, limit: 100 });
}

export async function listAroFloUsers(businessUnitId) {
  return arofloProbe('/users', { businessUnitId, limit: 100 });
}
