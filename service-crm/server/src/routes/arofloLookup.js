import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { all } from '../db/index.js';
import {
  ArofloNotConfiguredError,
  ArofloRequestError,
  listBusinessUnits,
  findTaskByJobNumber,
  getTaskDetail,
  getInvoicesForTask,
  getCustomFieldValue,
  listTaskLabours,
  listTaskSchedules,
} from '../aroflo/client.js';
import { summarizeLabour, summarizeVisits } from '../aroflo/activity.js';
import { matchSuburbFromLocationText } from '../aroflo/suburbMatch.js';

// Production New Job lookup — a clean, already-decided summary for the real
// form, never the raw AroFlo shapes the admin-only /aroflo-test page shows.
// Still GET-only (no write capability exists anywhere this calls into), and
// a failure of any kind — not configured, AroFlo unreachable, no match — is
// reported as `found: false` with a plain message rather than an HTTP error,
// so a lookup problem never blocks manual entry on this form.

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// A single, confident match only — same "never guess, leave it to the human"
// rule as matchSuburbFromLocationText. AroFlo's schedule.resources only ever
// carries a free-text name (no stable id was found anywhere in testing), so
// this requires the CRM's own technician name to appear in full within it —
// e.g. "Ryan Smith" inside "Ryan Smith El Install" — never a partial/fuzzy
// match, and never applied when more than one technician matches.
function matchTechnicianByName(arofloName) {
  if (!arofloName) return null;
  const haystack = arofloName.toLowerCase();
  const technicians = all('SELECT id, name FROM technicians WHERE active = 1');
  const matches = technicians.filter((t) => haystack.includes(t.name.toLowerCase()));
  return matches.length === 1 ? matches[0].id : null;
}

// Only ever offered for a PENDING task — a completed task's schedule has
// consistently come back empty in every real test, so there's nothing
// reliable to offer there (see the Stage 1 investigation). Requires both a
// named resource and a date; either missing means nothing to suggest.
function buildScheduled(task) {
  if ((task.status || '').toUpperCase() !== 'PENDING') return null;
  const resources = task.schedule?.resources || [];
  const named = resources.find((r) => r && r.name);
  if (!named) return null;
  const date = (task.schedule.scheduleDate || task.schedule.startTime || '').slice(0, 10);
  if (!date) return null;
  return {
    technicianName: named.name,
    matchedTechnicianId: matchTechnicianByName(named.name),
    date,
  };
}

export function createArofloLookupRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/lookup', async (req, res) => {
    const jn = (req.query.jn || '').trim();
    if (!jn) return res.status(400).json({ error: 'Please enter a job number.' });

    try {
      const businessUnits = await listBusinessUnits();
      const businessUnit = businessUnits[0];
      if (!businessUnit) return res.json({ found: false, message: 'AroFlo did not return a business unit for this account.' });

      const task = await findTaskByJobNumber(businessUnit.id, jn);
      if (!task) return res.json({ found: false, message: `No matching AroFlo job found for "${jn}".` });

      const [detail, invoices] = await Promise.all([getTaskDetail(task.id), getInvoicesForTask(businessUnit.id, task.id)]);
      // AroFlo tracks "Lead Source" per customer (the CLIENTS zone), not per
      // job — its option list doesn't line up 1:1 with this CRM's own Lead
      // Source list (e.g. AroFlo's single "Google" vs. this CRM's separate
      // "Google search"/"Google ads"), so this is surfaced as a reference
      // value only for staff to read and pick the closest match themselves —
      // never auto-applied to a call's own leadSourceId.
      const leadSource = await getCustomFieldValue('CLIENTS', detail.client?.id || null, 'Lead Source');

      // Labour logged and visits booked on this job — display only, and only
      // when the caller asks (the Technician & Sales form does; the Lead
      // Source lookup on calls doesn't), so the two extra AroFlo calls are
      // never spent where nothing would show them. null for either means
      // AroFlo couldn't answer — never a reason to fail the lookup.
      let activity;
      if (req.query.activity === '1') {
        const [labours, schedules] = await Promise.all([listTaskLabours(task.id), listTaskSchedules(businessUnit.id, task.id)]);
        activity = { labour: summarizeLabour(labours), visits: summarizeVisits(schedules) };
      }

      res.json({
        found: true,
        status: detail.status || '',
        taskType: detail.taskType?.name || '',
        description: stripHtml(detail.description),
        // null when no single confident match exists — the caller must
        // never fall back to guessing, same contract as every other
        // suburb auto-fill already in this app.
        suburb: matchSuburbFromLocationText(detail.locationText),
        leadSource,
        invoices: invoices.map((inv) => ({
          invoiceNumber: inv.invoiceNumber || '',
          invoiceDate: inv.invoicedDateTime ? inv.invoicedDateTime.slice(0, 10) : '',
          saleValueExGst: inv.totalAmountEx ?? 0,
          status: inv.status || '',
        })),
        scheduled: buildScheduled(detail),
        activity,
      });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) {
        return res.json({ found: false, message: 'AroFlo lookup is not currently configured — enter this job manually.' });
      }
      if (err instanceof ArofloRequestError) {
        return res.json({ found: false, message: 'AroFlo could not be reached — you can still enter this job manually.' });
      }
      throw err;
    }
  });

  return router;
}
