import { all } from '../db/index.js';
import {
  probeClientDetail,
  probeClientJobHistory,
  probeSameNameClients,
  probeCustomFields,
  fetchAddressesForComparison,
  ADDRESS_LOOKUP_CAP,
} from './client.js';
import { analyzeClientHistory, summarizeCustomFields, compareAddresses, ADDRESS_UNABLE, ADDRESS_SAME } from './customerHistory.js';
import { resolveTaskType } from './taskTypeMapping.js';

// The customer-history check shared by the admin AroFlo Test page and the
// Calls & Contacts Repeat customer suggestion. Read-only: GET requests to
// AroFlo and SELECTs on the CRM only — nothing is stored, logged or changed.

// The current job's customer's EARLIER jobs (lower job number), completed
// ones first, for the same-address comparison.
function earlierTasksForComparison(probes, detail) {
  const byId = new Map();
  for (const p of [probes?.defaultList, probes?.archivedList]) {
    if (p?.available) (p.data?.items || []).forEach((t) => byId.set(t.id, t));
  }
  const done = (t) => String(t.status || '').toUpperCase() === 'COMPLETED' || !!t.completionDate;
  return [...byId.values()]
    .filter((t) => t.id !== detail.id && Number(t.jobNumber) < Number(detail.jobNumber))
    .sort((a, b) => Number(done(b)) - Number(done(a)) || Number(b.jobNumber) - Number(a.jobNumber));
}

const ZONES = ['TASKS (this job)', 'CLIENTS (the customer)', 'LOCATIONS (the site)'];

/** Every probe and the analysis for one AroFlo job. Only privacy-safe
 * summaries leave this function (no addresses, phones or emails). */
export async function gatherCustomerHistory(businessUnit, task, detail) {
  const clientId = detail.client?.id || null;
  const siteId = detail.location?.id || detail.location?.locationId || null;
  const clientDetail = await probeClientDetail(clientId);
  const probes = await probeClientJobHistory(businessUnit.id, clientId, siteId);
  const clientName = clientDetail?.available ? clientDetail.data?.name : detail.client?.name;
  const sameNameClients = await probeSameNameClients(clientName);
  const customFields = await probeCustomFields(task.id, clientId, siteId);
  const earlierTasks = earlierTasksForComparison(probes, detail);
  const addressRead = await fetchAddressesForComparison(earlierTasks);
  // Only the outcome of each comparison is kept — never an address.
  const addressChecks = new Map(
    earlierTasks.map((t) => [t.id, addressRead.addresses.get(t.id) ? compareAddresses(detail, addressRead.addresses.get(t.id)) : ADDRESS_UNABLE])
  );
  const fieldSummaries = [
    summarizeCustomFields(customFields[0], ZONES[0]),
    summarizeCustomFields(customFields.find((r) => r.tried.includes('CLIENTS')), ZONES[1]),
    siteId ? summarizeCustomFields(customFields.find((r) => r.tried.includes('LOCATIONS')), ZONES[2]) : { zone: ZONES[2], available: false, note: 'This job has no linked site record.', fields: [] },
  ].filter(Boolean);
  const occupant = fieldSummaries.map((z) => z.occupant).find(Boolean) || null;
  return {
    analysis: analyzeClientHistory({ currentTask: detail, clientDetail, probes, sameNameClients, addressChecks, occupant }),
    fieldSummaries,
    addressComparison: { compared: earlierTasks.length, extraRequests: addressRead.requests, cap: ADDRESS_LOOKUP_CAP, capped: addressRead.capped },
    probes,
    sameNameClients,
  };
}

const normKey = (v) => String(v || '').trim().toLowerCase();

/**
 * CRM evidence that a Job Number is a callback (read-only):
 * - the NEW callback Job Number on a Technician & Sales Call Back entry
 *   (different from that entry's original Job Number);
 * - a Calls & Contacts "Call back" record with this Job Number (the call
 *   being edited, if any, is ignored).
 * Returns a list of plain reasons; empty when there's none.
 */
export function callbackEvidence(jobNumber, excludeCallId = null) {
  const key = normKey(jobNumber);
  if (!key) return [];
  const reasons = [];
  const entries = all('SELECT job_number, new_job_number FROM call_backs WHERE archived = 0').filter(
    (cb) => normKey(cb.new_job_number) === key && normKey(cb.new_job_number) !== normKey(cb.job_number)
  );
  if (entries.length) reasons.push(`it's the new callback Job Number on a Technician & Sales Call Back entry`);
  const calls = all("SELECT id, job_number FROM calls WHERE archived = 0 AND call_type = 'Call back'").filter(
    (c) => normKey(c.job_number) === key && String(c.id) !== String(excludeCallId ?? '')
  );
  if (calls.length) reasons.push(`it's on a Calls & Contacts "Call back" record`);
  return reasons;
}

// Facts that make an earlier completed job a GENUINE possibility the CRM
// can't rule out — these leave the Lead Source for staff (step 3).
function repeatPossibilities(a) {
  const out = [];
  if (a.earlierCompletedCount > 0) {
    const same = a.earlierCompletedAtSameAddress ?? 0;
    const why = [];
    const different = (a.earlierJobs || []).filter((t) => t.outcome === 'completed' && t.address === 'different address').length;
    const unable = (a.earlierJobs || []).filter((t) => t.outcome === 'completed' && t.address === 'unable to compare').length;
    if (different) why.push(`${different} at a different address`);
    if (unable) why.push(`${unable} whose address couldn't be compared`);
    if (same && !why.length) why.push('the customer record has warnings that stop an automatic Repeat customer classification');
    out.push(`This customer has ${a.earlierCompletedCount} earlier completed job(s) in AroFlo${why.length ? ` (${why.join('; ')})` : ''} — they may be a repeat customer, but the CRM can't confirm it.`);
  }
  if (a.sameNameCustomerRecords > 0) out.push(`${a.sameNameCustomerRecords} other AroFlo customer record(s) have exactly the same name — earlier work may sit under another record.`);
  if (a.sameNameCheckFailed) out.push("AroFlo couldn't be checked for duplicate customer records, so earlier work under another record can't be ruled out.");
  if (a.hasParent) out.push('The customer sits under a parent customer account — earlier work may be recorded under it.');
  if (a.customerFilterHonoured !== true) out.push("AroFlo's list of this customer's jobs couldn't be verified, so earlier work can't be ruled out.");
  if (a.siteFilterHonoured === false) out.push("AroFlo's list of this site's jobs couldn't be verified.");
  if (a.truncated) out.push('The customer has more jobs than were read — the history is incomplete.');
  if (!a.archivedChecked) out.push("Archived jobs couldn't be checked — the history is incomplete.");
  if (a.completedOrderingConflicts > 0) out.push(`${a.completedOrderingConflicts} completed job(s) are ordered differently by job number and by date, so they may be earlier work.`);
  return out;
}

// Facts that only make the customer ineligible for an AUTOMATIC Repeat
// customer classification — shown as information, never blocking the mapped
// Lead Source when there's no possibility of earlier work.
function eligibilityWarnings(a) {
  const out = [];
  if (a.occupant && !/^(home\s*owner|owner|owner[\s-]*occupier|owner[\s-]*occupied)$/i.test(String(a.occupant).trim())) {
    out.push(`Occupant: ${a.occupant} — not eligible for automatic Repeat customer classification.`);
  }
  if (a.individual === false) out.push('The AroFlo customer is an organisation — not eligible for automatic Repeat customer classification.');
  if (a.individual === null || a.individual === undefined) out.push("AroFlo didn't say whether the customer is an individual — not eligible for automatic Repeat customer classification.");
  if (a.sites > 1) out.push(`The customer has ${a.sites} sites/properties — not eligible for automatic Repeat customer classification.`);
  return out;
}

/**
 * The Lead Source decision for the call form, in the agreed order:
 * 1. callback (CRM evidence, or AroFlo task type Call Back) -> 'callback':
 *    no Lead Source;
 * 2. confident earlier completed job, same individual, same address,
 *    complete history, no warnings -> 'repeat': Repeat customer;
 * 3. a genuine possibility of earlier completed work the CRM can't confirm
 *    (earlier completed jobs it can't classify, possible duplicate records,
 *    a parent account, an incomplete or unverifiable history) ->
 *    'uncertain': left for staff, with the reasons;
 * 4. otherwise -> 'no-earlier': the mapped AroFlo customer-card Lead Source,
 *    with any eligibility warnings (Occupant, organisation, several sites)
 *    shown as information only — they never block it on their own.
 * `history` is gatherCustomerHistory()'s result; `crmReasons` from
 * callbackEvidence(). Privacy-safe output only.
 */
export function repeatDecision({ crmReasons = [], detail, history }) {
  const reasons = [...crmReasons];
  if (detail && resolveTaskType(detail.taskType?.name).kind === 'callback') reasons.push('its AroFlo task type is Call Back');
  if (reasons.length) return { kind: 'callback', reasons };
  if (!history) return null; // not a callback; the history check comes next
  const a = history.analysis;
  if (!a.clientId) return { kind: 'uncertain', reasons: a.reasons || ['This AroFlo job has no customer attached.'], warnings: [] };
  const warnings = eligibilityWarnings(a);
  if (a.assessment === 'repeat') {
    const sameAddress = (a.earlierJobs || []).filter((t) => t.outcome === 'completed' && t.address === ADDRESS_SAME);
    const latest = sameAddress.sort((x, y) => Number(y.jobNumber) - Number(x.jobNumber))[0];
    if (latest) {
      return { kind: 'repeat', reasons: [], warnings: [], earlierJob: { jobNumber: latest.jobNumber, completed: latest.completed ? String(latest.completed).slice(0, 10) : null } };
    }
  }
  const possibilities = repeatPossibilities(a);
  if (possibilities.length) return { kind: 'uncertain', reasons: possibilities, warnings };
  return { kind: 'no-earlier', reasons: [], warnings };
}
