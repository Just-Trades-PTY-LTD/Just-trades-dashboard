// What the Technician & Sales form does when Lead Qualification or the
// New Job entry type changes — the form-side twin of the server's
// lib/leadRules.js. Each function returns the form to switch to and a list
// of what that switch would clear or replace; when that list isn't empty the
// form asks for confirmation first, so nothing staff entered is discarded
// silently.

export const NA = 'N/A';
const NO_SALE = 'new_job_no_sale';
const SALE_MADE = 'new_job_sale_made';
const isYesNo = (v) => v === 'Yes' || v === 'No';

/** Lead Qualification changed to `lead`. */
export function changeLead(form, lead, { reasonName } = {}) {
  if (form.kind === NO_SALE && lead === 'Not Qualified' && form.lead !== 'Not Qualified') {
    const lost = [];
    if (isYesNo(form.inspectionSheet)) lost.push(`Inspection Sheet (currently ${form.inspectionSheet}) will be set to N/A`);
    if (isYesNo(form.optionSheet)) lost.push(`Option Sheet (currently ${form.optionSheet}) will be set to N/A`);
    if (form.knockbackReasonId) lost.push(`Reason for knock back (${reasonName || 'selected'}) will be cleared`);
    if (form.followUpRequired) lost.push('the follow-up reminder will be removed');
    return {
      lost,
      next: { ...form, lead, inspectionSheet: NA, optionSheet: NA, knockbackReasonId: '', followUpRequired: false, followUpDueDate: '' },
    };
  }
  if (form.kind === NO_SALE && form.lead === 'Not Qualified' && lead !== 'Not Qualified') {
    // Back to normal selection — the automatic N/A doesn't stay behind.
    return {
      lost: [],
      next: {
        ...form,
        lead,
        inspectionSheet: form.inspectionSheet === NA ? '' : form.inspectionSheet,
        optionSheet: form.optionSheet === NA ? '' : form.optionSheet,
      },
    };
  }
  return { lost: [], next: { ...form, lead } };
}

/** Switching between New Job — No Sale and New Job — Sale Made keeps
 * everything the two share; only what doesn't apply to the new type is
 * cleared. Returns null for any other switch. */
export function switchNewJobKind(form, kind, { reasonName, emptyForm } = {}) {
  if (![NO_SALE, SALE_MADE].includes(form.kind) || ![NO_SALE, SALE_MADE].includes(kind) || form.kind === kind) return null;
  const lost = [];
  if (kind === SALE_MADE) {
    if (form.lead === 'Not Qualified') lost.push('Lead will change from Not Qualified to Qualified (a Sale Made job is always Qualified)');
    if (form.knockbackReasonId) lost.push(`Reason for knock back (${reasonName || 'selected'}) will be cleared`);
    if (form.followUpRequired) lost.push('the follow-up reminder will be removed');
    const wasNotQualified = form.lead === 'Not Qualified';
    return {
      lost,
      next: {
        ...form,
        kind,
        lead: 'Qualified',
        // The automatic N/A from Not Qualified returns to normal selection.
        inspectionSheet: wasNotQualified && form.inspectionSheet === NA ? '' : form.inspectionSheet,
        optionSheet: wasNotQualified && form.optionSheet === NA ? '' : form.optionSheet,
        knockbackReasonId: '',
        followUpRequired: false,
        followUpDueDate: '',
      },
    };
  }
  const blank = emptyForm(kind);
  if (form.invoiceNumber) lost.push(`Invoice number (${form.invoiceNumber}) will be cleared`);
  if (form.saleValueExGst !== '' && form.saleValueExGst !== null && form.saleValueExGst !== undefined) lost.push(`Sale value ($${form.saleValueExGst}) will be cleared`);
  if (form.workCompletion) lost.push('Work completion will be cleared');
  if (form.installTechnicianId || form.installDate) lost.push('Install technician/date will be cleared');
  return {
    lost,
    next: {
      ...form,
      kind,
      invoiceNumber: blank.invoiceNumber,
      invoiceDate: blank.invoiceDate,
      saleValueExGst: blank.saleValueExGst,
      workCompletion: blank.workCompletion,
      installTechnicianId: blank.installTechnicianId,
      installDate: blank.installDate,
    },
  };
}

/** Anything staff have entered that a full reset (any other entry-type
 * switch) would throw away. Dates that default to today don't count. */
export function hasEnteredDetails(form, emptyForm) {
  if (!form.kind) return false;
  const blank = emptyForm(form.kind);
  const ignore = new Set(['kind', 'visitDate', 'dateLogged', 'invoiceDate', 'followUpDueDate']);
  return Object.keys(blank).some((k) => !ignore.has(k) && form[k] !== blank[k] && form[k] !== '' && form[k] !== null && form[k] !== false);
}

export function confirmMessage(intro, lost) {
  return `${intro}\n\n${lost.map((l) => `• ${l}`).join('\n')}\n\nContinue?`;
}
