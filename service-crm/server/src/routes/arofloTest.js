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
  listTaskTypes,
  listLocations,
  listAroFloUsers,
} from '../aroflo/client.js';

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
      const [history, locationDetail] = await Promise.all([
        probeTaskHistory(businessUnit.id, task.id),
        probeLocationDetail(locationId),
      ]);

      res.json({
        found: true,
        summary: summarize(detail, invoices),
        investigation: { history, locationDetail },
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

  router.get('/task-types', (req, res) => listingRoute(req, res, listTaskTypes));
  router.get('/locations', (req, res) => listingRoute(req, res, listLocations));
  router.get('/users', (req, res) => listingRoute(req, res, listAroFloUsers));

  return router;
}
