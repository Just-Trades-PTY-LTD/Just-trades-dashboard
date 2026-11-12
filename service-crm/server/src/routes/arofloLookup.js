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
  getCustomFieldValues,
  listTaskLabours,
  listTaskSchedules,
  countArofloCalls,
} from '../aroflo/client.js';
import { summarizeLabour, summarizeVisits, toLocalDateTime } from '../aroflo/activity.js';
import { analyzeTaskSuburb, addressSummary } from '../aroflo/suburbMatch.js';
import { resolveTaskType } from '../aroflo/taskTypeMapping.js';
import { findRecordedSaleForInvoice, invoiceKey } from '../services/lookup.js';
import { crmInvoicesForJob, cancellationsOnInvoice } from '../services/pendingCancellation.js';
import { resolveLeadSourceValues } from '../aroflo/leadSourceMapping.js';
import { gatherCustomerHistory, callbackEvidence, repeatDecision } from '../aroflo/repeatCheck.js';
import { LEAD_SOURCE_FIELD_NAMES } from '../aroflo/customerHistory.js';

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

function recordedSaleLabel(invoiceNumber) {
  const sale = findRecordedSaleForInvoice(invoiceNumber);
  if (!sale) return null;
  return { jobNumber: sale.job_number, kind: sale.source === 'quote_approved_later' ? 'Quote Approved Later' : 'Sale Made' };
}

export function createArofloLookupRouter() {
  const router = Router();
  router.use(requireAuth);

  // Calls & Contacts: is this Lead call's customer a returning customer?
  // Run automatically by the call form AFTER its normal lookup (so that
  // lookup is never slowed), in the agreed order — callback first, then a
  // confident repeat, else no earlier job / uncertain. Read-only: GET
  // requests to AroFlo and reads of the CRM only. Returns privacy-safe
  // results only (no address, phone or email); nothing is stored or logged,
  // and nothing on the form changes unless staff click "Use this".
  router.get('/lead-history', async (req, res) => {
    const jn = (req.query.jn || '').trim();
    if (!jn) return res.status(400).json({ error: 'Please enter a job number.' });
    const started = Date.now();
    const done = (body) => res.json({ ...body, elapsedMs: Date.now() - started });
    try {
      // 1. CRM callback evidence needs no AroFlo request at all.
      const crmReasons = callbackEvidence(jn, req.query.excludeCallId || null);
      if (crmReasons.length) return done({ found: true, kind: 'callback', reasons: crmReasons, requests: 0 });
      const { result, calls } = await countArofloCalls(async () => {
        const businessUnit = (await listBusinessUnits())[0];
        if (!businessUnit) return { found: false, kind: 'unavailable', message: 'AroFlo did not return a business unit for this account.' };
        const task = await findTaskByJobNumber(businessUnit.id, jn);
        if (!task) return { found: false, kind: 'unavailable', message: `No matching AroFlo job found for "${jn}".` };
        const detail = await getTaskDetail(task.id);
        // AroFlo task type Call Back: decided before any history request.
        const early = repeatDecision({ crmReasons, detail, history: null });
        if (early) return { found: true, ...early };
        const history = await gatherCustomerHistory(businessUnit, task, detail);
        return { found: true, ...repeatDecision({ crmReasons, detail: null, history }) };
      });
      return done({ ...result, requests: calls });
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) return done({ found: false, kind: 'unavailable', message: 'AroFlo lookup is not currently configured.' });
      if (err instanceof ArofloRequestError) return done({ found: false, kind: 'unavailable', message: 'AroFlo could not be reached for the customer history check.' });
      throw err;
    }
  });

  // Stage 5 — Calls & Contacts Pending Cancellation: the Job Number's
  // invoices, one entry per invoice (never combined): the CRM's recorded
  // value ex GST (original sale + Upsells on that invoice) and AroFlo's
  // current value ex GST and status, plus any other cancellation already on
  // that invoice. Read-only: GET requests to AroFlo, SELECTs on the CRM.
  // AroFlo unavailable -> the CRM invoices alone, with a note.
  router.get('/pending-cancellation-invoices', async (req, res) => {
    const jn = (req.query.jn || '').trim();
    if (!jn) return res.status(400).json({ error: 'Please enter a job number.' });
    const pcId = Number(req.query.pendingCancellationId) || null;
    const crm = crmInvoicesForJob(jn);
    let aroflo = [];
    let arofloNote = null;
    try {
      const businessUnit = (await listBusinessUnits())[0];
      const task = businessUnit ? await findTaskByJobNumber(businessUnit.id, jn) : null;
      if (!task) arofloNote = `No AroFlo job found for "${jn}" — only the CRM's invoices are shown.`;
      else {
        aroflo = (await getInvoicesForTask(businessUnit.id, task.id)).map((inv) => ({
          id: inv.id || inv.invoiceId || '',
          invoiceNumber: String(inv.invoiceNumber || '').trim(),
          invoiceDate: toLocalDateTime(inv.invoicedDateTime).date,
          valueExGst: inv.totalAmountEx ?? null,
          status: inv.status || '',
        }));
      }
    } catch (err) {
      if (err instanceof ArofloNotConfiguredError) arofloNote = 'AroFlo lookup is not configured — only the CRM\'s invoices are shown.';
      else if (err instanceof ArofloRequestError) arofloNote = 'AroFlo could not be reached — only the CRM\'s invoices are shown.';
      else throw err;
    }
    const keys = [...new Set([...crm.map((c) => c.key), ...aroflo.filter((a) => a.invoiceNumber).map((a) => invoiceKey(a.invoiceNumber))])];
    const invoices = keys.map((key) => {
      const c = crm.find((x) => x.key === key) || null;
      const a = aroflo.find((x) => invoiceKey(x.invoiceNumber) === key) || null;
      return {
        key,
        invoiceNumber: a?.invoiceNumber || c?.invoiceNumber || '',
        invoiceDate: a?.invoiceDate || c?.invoiceDate || '',
        crm: c ? { saleId: c.saleId, valueExGst: c.crmValueExGst, saleValueExGst: c.saleValueExGst, upsellValueExGst: c.upsellValueExGst, upsellCount: c.upsellCount } : null,
        aroflo: a ? { id: a.id, valueExGst: a.valueExGst, status: a.status } : null,
        otherCancellations: cancellationsOnInvoice(c?.invoiceNumber || a?.invoiceNumber, pcId),
      };
    });
    res.json({ jobNumber: jn, invoices, arofloNote, capturedAt: new Date().toISOString() });
  });

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
      const leadSourceValues = await getCustomFieldValues('CLIENTS', detail.client?.id || null, LEAD_SOURCE_FIELD_NAMES);
      const leadSource = leadSourceValues[0]?.value ?? null;

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

      const suburbAnswer = analyzeTaskSuburb({ location: detail.location, locationText: detail.locationText });
      res.json({
        found: true,
        status: detail.status || '',
        taskType: detail.taskType?.name || '',
        // What that task type means for the forms: an admin mapping first,
        // then the exact-name fallback, else nothing (never guessed).
        taskTypeMatch: resolveTaskType(detail.taskType?.name),
        description: stripHtml(detail.description),
        // null when no single confident match exists — the caller must
        // never fall back to guessing, same contract as every other
        // suburb auto-fill already in this app.
        suburb: suburbAnswer.suburb,
        // Only when no confident suburb was found: a privacy-safe summary of
        // the job's own AroFlo address (suburb words, state and postcode — no
        // house number or street), shown read-only so staff can choose the
        // suburb. Never stored, never the customer's postal address, and
        // never sent when a suburb was matched.
        addressForReference: suburbAnswer.suburb ? null : addressSummary(detail),
        leadSource,
        // The customer's AroFlo Lead Source value(s), resolved through the
        // admin mapping / exact name: one clear CRM Lead Source, unmapped
        // (reference only) or a conflict between the two AroFlo fields
        // (left for staff). A suggestion only on the call form.
        leadSourceMatch: resolveLeadSourceValues(leadSourceValues),
        invoices: invoices.map((inv) => ({
          invoiceNumber: inv.invoiceNumber || '',
          // Adelaide calendar date: a UTC timestamp is converted, a plain
          // local one is read as-is (see toLocalDateTime).
          invoiceDate: toLocalDateTime(inv.invoicedDateTime).date,
          // This invoice's own total ex GST — never the task's sell total.
          saleValueExGst: inv.totalAmountEx ?? 0,
          status: inv.status || '',
          // Already recorded on a CRM sale (any job)? Then the forms never
          // fill it into another sale — it's listed with this label instead.
          alreadyRecorded: recordedSaleLabel(inv.invoiceNumber),
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
