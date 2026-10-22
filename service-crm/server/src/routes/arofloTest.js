import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  ArofloNotConfiguredError,
  ArofloRequestError,
  listBusinessUnits,
  findTaskByJobNumber,
  getTaskDetail,
  getInvoicesForTask,
} from '../aroflo/client.js';

// Stage 1: a completely separate, admin-only, read-only test page. It makes
// zero writes to AroFlo and zero writes to this CRM's own database — it only
// looks a job number up in AroFlo and shows what comes back. Nothing here
// touches the live New Job form, jobs/sales tables, or any existing report.
function summarize(task, invoices) {
  const assignedUsers = (task.resources || [])
    .filter((r) => r.resourceType === 'USER' && r.status === 'ASSIGNED')
    .map((r) => r.resource);
  return {
    arofloTaskId: task.id,
    jobNumber: task.jobNumber,
    name: task.name,
    description: task.description,
    status: task.status,
    taskType: task.taskType?.name || null,
    suburb: task.location?.suburb || null,
    locationText: task.locationText || null,
    enteredBy: task.enteredBy || null,
    reportedBy: task.reportedBy || null,
    requestedDateTime: task.requestedDateTime || null,
    invoiced: task.invoiced ?? null,
    assignedUsers,
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

      res.json({
        found: true,
        summary: summarize(detail, invoices),
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

  return router;
}
