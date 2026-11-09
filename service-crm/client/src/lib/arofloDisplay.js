// What the entry form SHOWS after an AroFlo lookup — display only. Which
// fields are filled, and when, is decided elsewhere (lib/arofloPrefill.js
// for a new New Job entry, lib/arofloFill.js for the other entry types and
// for editing); nothing here changes the form or what is saved.
//
// Rules:
// - A value AroFlo already put into the form is never offered again: the
//   form shows one compact confirmation naming the fields filled instead.
// - "Use this" appears only where AroFlo's value isn't already in the form:
//   a different manual value, a genuine choice (several invoices), or an
//   entry being edited (where nothing is changed automatically).
// - AroFlo's logged time and booked visits are read-only reference, shown
//   only behind a collapsed link, and only when there is something to show.

// Field groups as staff see them, in form order. Fields filled together
// (invoice number/date/value; work completion/install date/technician) are
// named once.
const FIELD_GROUPS = [
  ['Suburb', ['suburb']],
  ['Trade / Job type', ['tradeId', 'jobTypeId']],
  ['Invoice', ['invoiceNumber', 'invoiceDate', 'saleValueExGst']],
  ['Work completion', ['workCompletion']],
  ['Install date', ['installDate']],
  ['Install technician', ['installTechnicianId']],
  ['Comments', ['comments']],
];

/** Names of the fields an automatic fill put into the form, e.g.
 * ['Suburb', 'Invoice', 'Comments'] — names only, never the values. */
export function filledFieldNames(filledKeys) {
  const keys = new Set(filledKeys || []);
  return FIELD_GROUPS.filter(([, fields]) => fields.some((f) => keys.has(f))).map(([name]) =>
    // A Trade-only mapping fills the Trade and leaves the Job type for staff.
    name === 'Trade / Job type' && !keys.has('jobTypeId') ? 'Trade' : name
  );
}

/** The one confirmation line for an automatic fill, or null when nothing
 * was filled. */
export function prefillConfirmation(filledKeys) {
  const names = filledFieldNames(filledKeys);
  return names.length ? `AroFlo details added — please check before saving: ${names.join(', ')}.` : null;
}

const invoiceKey = (v) => String(v ?? '').trim().toLowerCase();

/** AroFlo invoices still worth offering: every invoice except the one the
 * form already holds (same invoice number), so an applied invoice never
 * shows "Use this" again. */
export function invoiceChoices(result, form) {
  const invoices = result?.found && Array.isArray(result.invoices) ? result.invoices : [];
  const current = invoiceKey(form?.invoiceNumber);
  return invoices.filter((inv) => invoiceKey(inv.invoiceNumber) && invoiceKey(inv.invoiceNumber) !== current);
}

/** Sale Made: whether AroFlo's scheduled return visit is already what the
 * form shows (install scheduled on that date, with that technician when
 * AroFlo's technician matched one) — then there's nothing to offer. */
export function scheduleApplied(scheduled, form, differentDayLabel) {
  if (!scheduled) return true;
  if (form.workCompletion !== differentDayLabel || form.installDate !== scheduled.date) return false;
  return !scheduled.matchedTechnicianId || String(form.installTechnicianId) === String(scheduled.matchedTechnicianId);
}

/** Call Back: whether AroFlo's one confidently-matched technician is
 * already the attending technician. */
export function attendingTechnicianApplied(scheduled, form) {
  return !scheduled?.matchedTechnicianId || String(form.technicianId) === String(scheduled.matchedTechnicianId);
}

/** Whether AroFlo returned any logged time or booked visits to show. */
export function hasActivity(activity) {
  return !!activity && ((Array.isArray(activity.labour) && activity.labour.length > 0) || (Array.isArray(activity.visits) && activity.visits.length > 0));
}
