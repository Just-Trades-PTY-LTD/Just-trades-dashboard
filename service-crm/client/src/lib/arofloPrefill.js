// Automatic AroFlo prefill for a NEW, unsaved "New Job" entry (No Sale or
// Sale Made) — run once staff finish typing the Job Number, or from the
// "Look up in AroFlo" button. Form only: nothing is saved or created here.
//
// Rules (agreed with the business):
// - Only BLANK fields are filled, and only from one clear, reliable match.
//   Anything staff typed or picked is never replaced; where AroFlo differs,
//   or there's more than one possibility, it's shown as a note (with "Use
//   this" where a single value exists) and the field is left for staff.
// - Never filled from AroFlo: the visit Technician (it's who the sale is
//   credited to), Lead, the sheets, the knock-back reason.
// - Sale Made only: one invoice -> its number, date and value ex GST (that
//   invoice's own totalAmountEx); work completion from AroFlo's visits.
// - Every filled value is remembered (field -> { value, prior }) so a new
//   Job Number can take back exactly what this lookup filled — and only
//   where the field still shows that value.
// All dates are Adelaide calendar dates (the server converts AroFlo times).

import { matchJobType } from './arofloCallSuggest.js';

export const COMPLETED_ON_VISIT = 'Completed on this visit';
export const DIFFERENT_DAY = 'Install scheduled — different day';

/** The one ACTIVE CRM technician whose full name appears within AroFlo's
 * name for the person (the same rule the server uses), or null when there
 * are none or several. Never a partial or "similar" name. */
export function matchTechnician(arofloName, technicians) {
  const hay = String(arofloName || '').toLowerCase().trim();
  if (!hay) return null;
  const hits = (technicians || []).filter((t) => t.active !== false && t.name && hay.includes(t.name.toLowerCase().trim()));
  return hits.length === 1 ? hits[0] : null;
}

const isBlank = (form, field, defaults) => {
  const v = form[field];
  return v === '' || v === null || v === undefined || (field in (defaults || {}) && v === defaults[field]);
};

/**
 * Work completion for a Sale Made entry, from AroFlo's booked visits and
 * logged time. `now` is { date: 'YYYY-MM-DD', time: 'HH:MM' } in Adelaide.
 * Returns { values, note } — values is {} whenever anything is uncertain.
 */
export function workCompletionFromAroflo(result, form, now, technicians) {
  const visits = result?.activity?.visits;
  const labour = result?.activity?.labour;
  if (!Array.isArray(visits)) {
    return { values: {}, note: "AroFlo's booked visits couldn't be read, so Work completion is left for you to choose." };
  }
  // A genuine future visit: after right now (Adelaide) and on a later day
  // than this entry's own visit date.
  const future = visits.filter(
    (v) => v.date && (v.date > now.date || (v.date === now.date && v.start && v.start > now.time)) && (!form.visitDate || v.date > form.visitDate)
  );
  const dates = [...new Set(future.map((v) => v.date))].sort();

  if (dates.length > 1) {
    return {
      values: {},
      note: `AroFlo has visits booked on ${dates.length} different future dates (${dates.join(', ')}), so Work completion, install date and install technician are left for you to choose.`,
    };
  }
  if (dates.length === 1) {
    const date = dates[0];
    const names = [...new Set(future.map((v) => v.technician).filter(Boolean))];
    const values = { workCompletion: DIFFERENT_DAY, installDate: date };
    let note = '';
    if (names.length === 1) {
      const tech = matchTechnician(names[0], technicians);
      if (tech) values.installTechnicianId = String(tech.id);
      else note = `The visit on ${date} is booked for "${names[0]}", who doesn't match exactly one technician here — please choose the install technician.`;
    } else if (names.length > 1) {
      note = `The visit on ${date} has ${names.length} people booked (${names.join(', ')}) — please choose the install technician.`;
    } else {
      note = `The visit on ${date} has no named technician — please choose the install technician.`;
    }
    return { values, note };
  }

  const status = String(result?.status || '').toUpperCase();
  if (status !== 'COMPLETED') {
    return {
      values: {},
      note: `AroFlo shows this job as ${result?.status || 'not completed'} with no future visit booked, so Work completion is left for you to choose.`,
    };
  }
  // Completed, nothing booked ahead. Extra safety check: time logged on a
  // later day than this visit means the work may have been finished on a
  // different day, so that's left for staff rather than assumed.
  if (!Array.isArray(labour)) {
    return { values: {}, note: "AroFlo's logged time couldn't be read, so Work completion is left for you to choose." };
  }
  const later = [...new Set(labour.map((l) => l.date).filter((d) => d && form.visitDate && d > form.visitDate))].sort();
  if (later.length) {
    return {
      values: {},
      note: `AroFlo shows time logged on a later day (${later.join(', ')}), so the work may have been finished on a different day — please choose Work completion.`,
    };
  }
  return { values: { workCompletion: COMPLETED_ON_VISIT }, note: '' };
}

/**
 * Everything one lookup would put into a new New Job form.
 * Returns { wanted, notes, suggestions } — `wanted` holds only fields this
 * lookup is confident about (blank-only is applied by applyPrefill below);
 * `notes` are plain messages; `suggestions` are single values staff can
 * apply with "Use this" when the field already holds something else.
 */
export function planNewJobPrefill({ result, form, now, trades, technicians }) {
  const wanted = {};
  const notes = [];
  const suggestions = [];
  if (!result?.found) return { wanted, notes, suggestions };
  const isSaleMade = form.kind === 'new_job_sale_made';

  if (result.suburb) {
    if (!form.suburb) wanted.suburb = result.suburb;
    else if (form.suburb !== result.suburb) suggestions.push({ label: `Suburb: ${result.suburb}`, values: { suburb: result.suburb } });
  } else {
    notes.push("No single confident suburb match from AroFlo's job address — please choose the suburb.");
  }

  if (result.description && !form.comments) wanted.comments = result.description;

  const jt = matchJobType(result.taskType, trades);
  if (jt) {
    const values = { tradeId: String(jt.tradeId), jobTypeId: String(jt.jobTypeId) };
    if (!form.tradeId && !form.jobTypeId) Object.assign(wanted, values);
    else if (String(form.tradeId) !== values.tradeId || String(form.jobTypeId) !== values.jobTypeId) {
      suggestions.push({ label: `Trade / Job type: ${jt.label}`, values });
    }
  } else if (result.taskType) {
    notes.push(`AroFlo task type "${result.taskType}" doesn't match exactly one Trade / Job type here — please choose them.`);
  }

  if (isSaleMade) {
    const invoices = result.invoices || [];
    if (invoices.length === 1) {
      const inv = invoices[0];
      wanted.invoiceNumber = inv.invoiceNumber;
      if (inv.invoiceDate) wanted.invoiceDate = inv.invoiceDate;
      wanted.saleValueExGst = inv.saleValueExGst;
    } else if (invoices.length > 1) {
      notes.push(`AroFlo has ${invoices.length} invoices on this job — select the right one below, or none.`);
    } else {
      notes.push('No invoice found on this job in AroFlo yet — enter the invoice details manually.');
    }

    const wc = workCompletionFromAroflo(result, form, now, technicians);
    if (wc.note) notes.push(wc.note);
    // Work completion, install date and install technician go together: if
    // staff already chose work completion, none of them are touched.
    if (Object.keys(wc.values).length) {
      if (!form.workCompletion) Object.assign(wanted, wc.values);
      else if (form.workCompletion !== wc.values.workCompletion) {
        suggestions.push({ label: `Work completion: ${wc.values.workCompletion}${wc.values.installDate ? ` on ${wc.values.installDate}` : ''}`, values: wc.values });
      }
    }
  }
  return { wanted, notes, suggestions };
}

/**
 * Applies a plan to the form, blank fields only, and takes back what the
 * previous lookup filled where it's still showing. `previous` / returned
 * `filled` are { field: { value, prior } }. `defaults` are fields whose
 * default value counts as blank (Invoice date defaults to today).
 * The invoice number, date and value are only filled together.
 */
export function applyPrefill(form, previous, wanted, defaults = {}) {
  const patch = {};
  Object.entries(previous || {}).forEach(([field, { value, prior }]) => {
    if (form[field] === value) patch[field] = prior;
  });
  const after = { ...form, ...patch };
  const want = { ...wanted };
  const invoiceFields = ['invoiceNumber', 'invoiceDate', 'saleValueExGst'].filter((f) => f in want);
  if (invoiceFields.length && !invoiceFields.every((f) => isBlank(after, f, defaults))) invoiceFields.forEach((f) => delete want[f]);
  const installFields = ['workCompletion', 'installDate', 'installTechnicianId'].filter((f) => f in want);
  if (installFields.length && !installFields.every((f) => isBlank(after, f, defaults))) installFields.forEach((f) => delete want[f]);
  if (('tradeId' in want || 'jobTypeId' in want) && !(isBlank(after, 'tradeId') && isBlank(after, 'jobTypeId'))) {
    delete want.tradeId;
    delete want.jobTypeId;
  }
  const filled = {};
  Object.entries(want).forEach(([field, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (!isBlank(after, field, defaults)) return;
    filled[field] = { value, prior: after[field] };
    patch[field] = value;
  });
  return { patch, filled };
}

/** Takes back what the last lookup filled (Job Number changed or cleared),
 * only where the field still shows that value. */
export function revertPrefill(form, previous) {
  return applyPrefill(form, previous, {}).patch;
}

/** One complete lookup step: take back what the previous lookup filled,
 * plan against the form as it is then, and fill. Returns { plan, patch,
 * filled }. */
export function prefillStep({ result, form, previous, now, trades, technicians, defaults }) {
  const reverted = { ...form, ...revertPrefill(form, previous) };
  const plan = planNewJobPrefill({ result, form: reverted, now, trades, technicians });
  const { patch, filled } = applyPrefill(form, previous, plan.wanted, defaults);
  return { plan, patch, filled };
}
