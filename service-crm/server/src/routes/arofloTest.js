import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  ArofloNotConfiguredError,
  ArofloRequestError,
  listBusinessUnits,
  findTaskByJobNumber,
  getTaskDetail,
  getInvoicesForTask,
  probeTaskHistory,
  probeLocationDetail,
  probeClientDetail,
  probeCustomFields,
  listTaskTypes,
  listLocations,
  listAroFloUsers,
  countArofloCalls,
  probeClientJobHistory,
  probeSameNameClients,
  listRecentTasks,
  getTaskAddress,
  listTaskTypesActiveAndArchived,
  fetchAddressesForComparison,
  ADDRESS_LOOKUP_CAP,
  sampleLeadSourceOptions,
  cleanArofloError,
} from '../aroflo/client.js';
import { LEAD_SOURCE_FIELD_NAMES } from '../aroflo/customerHistory.js';
import { gatherCustomerHistory } from '../aroflo/repeatCheck.js';
import { matchSuburbFromLocationText, analyzeTaskSuburb, legacyMatchSuburbFromLocationText, addressSummary } from '../aroflo/suburbMatch.js';

// Stage 1: a completely separate, admin-only, read-only test page. It makes
// zero writes to AroFlo and zero writes to this CRM's own database — it only
// looks a job number up in AroFlo and shows what comes back. Nothing here
// touches the live New Job form, jobs/sales tables, or any existing report.
//
// Investigation update: this used to collapse technician/schedule/location
// data into a few guessed fields (e.g. `assignedUsers` from task.resources
// alone), which is how testing missed that a technician name was actually
// sitting under task.schedule.resources instead. This now surfaces every
// raw field from those three areas (task.resources, task.schedule,
// task.location) AS-IS, under clearly separate names, rather than picking
// one source and presenting it as "the" technician/suburb. None of this
// decides or labels anything as the attending/selling technician — that
// judgement call is deliberately left to whoever reads this test page, and
// stays that way until a reliable rule is confirmed across real jobs.
export function summarize(task, invoices) {
  return {
    arofloTaskId: task.id,
    jobNumber: task.jobNumber,
    name: task.name,
    description: task.description,
    status: task.status,
    taskType: task.taskType?.name || null,
    suburb: task.location?.suburb || null,
    locationText: task.locationText || null,
    // The full location object, whatever AroFlo sends (id, postcode, state,
    // GPS, etc., if present) — `suburb` above is only ever one field of
    // this, pulled out purely for convenience.
    location: task.location || null,
    // The customer record this task belongs to — only noticed once a full
    // response was actually inspected; never surfaced before now.
    client: task.client || null,
    enteredBy: task.enteredBy || null,
    reportedBy: task.reportedBy || null,
    requestedDateTime: task.requestedDateTime || null,
    invoiced: task.invoiced ?? null,
    // Raw, unfiltered task-level resource assignments. NOT necessarily who
    // attended or sold the job — just whatever AroFlo returns here,
    // including any id field alongside a name, exactly as sent.
    taskResources: task.resources || [],
    // The schedule block embedded on this task, in full and unmodified —
    // covers resources/startTime/endTime and anything else AroFlo includes
    // here. If a task ever carries more than one schedule/visit record,
    // whatever shape AroFlo sends (object or array) appears here exactly as
    // returned, nothing reshaped or picked out.
    schedule: task.schedule || null,
    // Pulled out individually purely for a quicker read in this summary
    // table — never a different value than what's already inside `schedule`
    // above, and never auto-labelled as the attending or selling
    // technician: it's "scheduled", nothing more is assumed about it.
    scheduleResources: task.schedule?.resources || [],
    scheduleStartTime: task.schedule?.startTime || null,
    scheduleEndTime: task.schedule?.endTime || null,
    invoiceCount: invoices.length,
    invoices: invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoicedDateTime: inv.invoicedDateTime,
      totalAmountEx: inv.totalAmountEx,
      status: inv.status,
      type: inv.type,
    })),
  };
}

// The suburb each AroFlo source gives for this task, side by side, so real
// jobs can show which one is reliable before the live form relies on any
// but the first: the address-text match the New Job form uses today, the
// task's own structured location (empty on every job tested so far), and
// the customer record's address, used when a job has no separate site.
// Display only — nothing here is applied anywhere.
export function compareSuburbSources(task, clientDetail) {
  const clientAddress = clientDetail?.available ? clientDetail.data?.address : null;
  return {
    matchedFromAddressText: matchSuburbFromLocationText(task.locationText),
    taskLocation: task.location?.suburb ? { suburb: task.location.suburb, postcode: task.location.postCode ?? null } : null,
    customerAddress: clientAddress?.suburb ? { suburb: clientAddress.suburb, postcode: clientAddress.postcode ?? null } : null,
  };
}

export { addressSummary };

export function suburbCheckRow(jobNumber, task) {
  const proposed = analyzeTaskSuburb({ location: task.location, locationText: task.locationText });
  const current = legacyMatchSuburbFromLocationText(task.locationText);
  return {
    jobNumber,
    summary: addressSummary(task, proposed.suburb),
    current: current || null,
    proposed: proposed.suburb,
    outcome: proposed.status,
    reason: proposed.reason,
    change: current === proposed.suburb ? 'same' : !current && proposed.suburb ? 'newly matched' : current && !proposed.suburb ? 'now left blank' : 'different suburb',
  };
}

export function createArofloTestRouter() {
  const router = Router();
  router.use(requireAdmin);

  router.get('/lookup', async (req, res) => {
    const jn = (req.query.jn || '').trim();
    if (!jn) return res.status(400).json({ error: 'Please enter a job number.' });

    try {
      const businessUnits = await listBusinessUnits();
      const businessUnit = businessUnits[0];
      if (!businessUnit) {
        return res.status(502).json({ error: 'AroFlo returned no business units for this account.' });
      }

      const task = await findTaskByJobNumber(businessUnit.id, jn);
      if (!task) {
        return res.json({ found: false, message: `No task with job number "${jn}" was found in AroFlo (or it isn't accessible to this token).` });
      }

      const [detail, invoices] = await Promise.all([
        getTaskDetail(task.id),
        getInvoicesForTask(businessUnit.id, task.id),
      ]);

      // Experimental, read-only probes for information GET /tasks/{id}
      // doesn't reliably carry (historical attendance on a completed job,
      // a structured location record). Each one either comes back with
      // data or a clean "not available" result — see probeTaskHistory's own
      // comment for why a 404 here is a normal, useful outcome, never a
      // failure. These never affect the `summary`/`raw` fields above, and a
      // problem with any of them never breaks the rest of this lookup.
      const locationId = detail.location?.id || detail.location?.locationId || null;
      const [history, locationDetail, customFields, clientDetail] = await Promise.all([
        probeTaskHistory(businessUnit.id, task.id),
        probeLocationDetail(locationId),
        probeCustomFields(task.id, detail.client?.id || null, locationId),
        probeClientDetail(detail.client?.id || null),
      ]);

      res.json({
        found: true,
        summary: summarize(detail, invoices),
        investigation: {
          history,
          locationDetail,
          customFields,
          clientDetail,
          suburbComparison: compareSuburbSources(detail, clientDetail),
        },
        raw: { task: detail, invoices },
      });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof ArofloRequestError) {
        // eslint-disable-next-line no-console
        console.error('[aroflo-test] request failed:', err.message);
        return res.status(502).json({ error: `${err.message} Manual CRM entry is always still available.` });
      }
      throw err;
    }
  });

  // Business-unit-wide reference listings — not tied to one job number, for
  // investigating the complete set of AroFlo Task Types (future Trade/Job
  // Type mapping) and whether a structured Locations list exists at all.
  // Same rules as /lookup: GET-only, admin-only, never writes anything,
  // never surfaces the token. A probe that comes back unavailable (e.g. a
  // 404) is a normal, informative result here, not an error state.
  async function listingRoute(req, res, probeFn) {
    try {
      const businessUnits = await listBusinessUnits();
      const businessUnit = businessUnits[0];
      if (!businessUnit) {
        return res.status(502).json({ error: 'AroFlo returned no business units for this account.' });
      }
      res.json(await probeFn(businessUnit.id));
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }

  // Customer history investigation: can AroFlo list this job's customer's
  // other jobs, and how reliably? Separate from /lookup so its extra AroFlo
  // requests are only spent when an admin asks. Read-only like everything
  // here: GET requests to AroFlo only, nothing stored, nothing in the CRM
  // read or changed. Reports how many AroFlo requests it took and how long.
  // Only privacy-safe summaries are returned — never phone numbers, email
  // addresses or street addresses.
  router.get('/customer-history', async (req, res) => {
    const jn = (req.query.jn || '').trim();
    if (!jn) return res.status(400).json({ error: 'Please enter a job number.' });
    const started = Date.now();
    try {
      const { result, calls } = await countArofloCalls(async () => {
        const businessUnit = (await listBusinessUnits())[0];
        if (!businessUnit) return { error: 'AroFlo returned no business units for this account.' };
        const task = await findTaskByJobNumber(businessUnit.id, jn);
        if (!task) return { found: false, message: `No task with job number "${jn}" was found in AroFlo.` };
        const detail = await getTaskDetail(task.id);
        const history = await countArofloCalls(() => gatherCustomerHistory(businessUnit, task, detail));
        const { analysis, fieldSummaries, addressComparison, probes, sameNameClients } = history.result;
        return {
          found: true,
          historyCalls: history.calls,
          addressComparison,
          analysis,
          customFields: fieldSummaries,
          probes: probes
            ? Object.fromEntries(
                Object.entries({ ...probes, sameNameClients })
                  .filter(([, v]) => v)
                  .map(([k, v]) => [
                    k,
                    { tried: v.tried, available: v.available, status: v.status ?? null, error: v.errorText ?? null, count: v.data?.count ?? null, returned: v.data?.items?.length ?? null, pagesFetched: v.pagesFetched ?? null, truncated: v.truncated ?? null },
                  ])
              )
            : null,
        };
      });
      if (result.error) return res.status(502).json({ error: result.error });
      res.json({ ...result, totalCalls: calls, elapsedMs: Date.now() - started });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) return res.status(400).json({ error: err.message });
      if (err instanceof ArofloRequestError) return res.status(502).json({ error: err.message });
      throw err;
    }
  });

  // Real-address suburb check: the most recent AroFlo jobs, each run through
  // today's suburb matcher and the proposed one. Only privacy-safe results
  // are returned — job number, a short address summary with no house number
  // and at most the last few words before the state, both results, the
  // outcome and the reason. Addresses are never stored or logged. Requests
  // run one after another (1 + 1 + count), capped at 40 jobs.
  router.get('/suburb-check', async (req, res) => {
    const count = Math.min(40, Math.max(1, Number(req.query.count) || 20));
    const started = Date.now();
    try {
      const { result, calls } = await countArofloCalls(async () => {
        const businessUnit = (await listBusinessUnits())[0];
        if (!businessUnit) return { error: 'AroFlo returned no business units for this account.' };
        const list = await listRecentTasks(businessUnit.id, count);
        if (!list.available) return { error: `AroFlo refused the recent jobs list (HTTP ${list.status || '—'}).` };
        const rows = [];
        for (const t of list.data?.items || []) {
          // eslint-disable-next-line no-await-in-loop
          const addr = await getTaskAddress(t.id);
          const task = addr.available ? addr.data || {} : { location: t.location };
          rows.push(suburbCheckRow(t.jobNumber, task));
        }
        return { rows };
      });
      if (result.error) return res.status(502).json({ error: result.error });
      const tally = result.rows.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
      res.json({ ...result, tally, totalCalls: calls, elapsedMs: Date.now() - started });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) return res.status(400).json({ error: err.message });
      if (err instanceof ArofloRequestError) return res.status(502).json({ error: err.message });
      throw err;
    }
  });

  // AroFlo's selectable Lead Source values, read from the custom-field
  // definitions returned with a few recent customers. Only field names and
  // option lists are returned — no customer, value or contact detail.
  router.get('/lead-source-options', async (req, res) => {
    const started = Date.now();
    try {
      const { result, calls } = await countArofloCalls(async () => {
        const businessUnit = (await listBusinessUnits())[0];
        if (!businessUnit) return { error: 'AroFlo returned no business units for this account.' };
        return sampleLeadSourceOptions(businessUnit.id, LEAD_SOURCE_FIELD_NAMES);
      });
      if (result.error) return res.status(502).json({ error: result.error });
      if (!result.available) return res.status(502).json({ error: `AroFlo refused the recent jobs list (HTTP ${result.status || '—'})${result.errorText ? `: ${result.errorText}` : ''}.` });
      res.json({ ...result, totalCalls: calls, elapsedMs: Date.now() - started });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) return res.status(400).json({ error: err.message });
      if (err instanceof ArofloRequestError) return res.status(502).json({ error: cleanArofloError(err.message) });
      throw err;
    }
  });

  router.get('/task-types-all', (req, res) => listingRoute(req, res, listTaskTypesActiveAndArchived));

  router.get('/task-types', (req, res) => listingRoute(req, res, listTaskTypes));
  router.get('/locations', (req, res) => listingRoute(req, res, listLocations));
  router.get('/users', (req, res) => listingRoute(req, res, listAroFloUsers));

  return router;
}
