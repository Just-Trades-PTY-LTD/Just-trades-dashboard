// Lead Qualification rules for "New Job" entries — the server-side backstop
// for the same rules the Technician & Sales form applies, so a conflicting
// combination can't be saved through any other request.
//
// - New Job — Sale Made is always Qualified; it can't be saved as Not
//   Qualified.
// - New Job — No Sale + Not Qualified: Inspection Sheet and Option Sheet are
//   N/A, there's no knock-back and no knock-back reason. N/A is already left
//   out of the inspection/option percentages (only Yes vs No is counted) and
//   knock-back/conversion figures only ever count Qualified jobs, so no
//   report calculation changes with this.
// - Qualified No Sale jobs keep the normal rules (sheets optional; a
//   knock-back reason is required).
//
// Existing records are never corrected automatically: an edit that doesn't
// change Lead keeps whatever an older record already has.

export const NA = 'N/A';

const isBlankOrNA = (v) => v === '' || v === null || v === undefined || v === NA;

/** For a brand-new entry. Returns { error } or { values } to store. */
export function checkNewJobLead({ isSaleMade, lead, inspectionSheet, optionSheet, knockbackReasonId }) {
  if (isSaleMade) {
    if (lead === 'Not Qualified') {
      return { error: 'A Sale Made job is always Qualified — it can’t be saved as Not Qualified.' };
    }
    return { values: { lead: 'Qualified', inspection_sheet: inspectionSheet || '', option_sheet: optionSheet || '' } };
  }
  if (lead === 'Not Qualified') {
    if (!isBlankOrNA(inspectionSheet) || !isBlankOrNA(optionSheet)) {
      return { error: 'A Not Qualified No Sale job has Inspection Sheet and Option Sheet set to N/A.' };
    }
    if (knockbackReasonId) {
      return { error: 'A Not Qualified No Sale job isn’t a knock-back, so it can’t have a Reason for Knockback.' };
    }
    return { values: { lead, inspection_sheet: NA, option_sheet: NA } };
  }
  return { values: { lead, inspection_sheet: inspectionSheet || '', option_sheet: optionSheet || '' } };
}

/**
 * For an edit. `existing` is the stored jobs row, `next` the merged values
 * about to be saved (lead, inspection_sheet, option_sheet,
 * knockback_reason_id), `links` = { openFollowUp, convertedLater }.
 * Returns { error, status } (nothing may be saved) or { values } to store,
 * including the recalculated knock-back flag.
 */
export function checkNewJobLeadEdit(existing, next, links) {
  const isSaleMade = !!existing.had_sale_at_visit;
  const leadChanged = next.lead !== existing.lead;

  if (isSaleMade && next.lead !== 'Qualified') {
    return {
      status: 400,
      error: leadChanged
        ? 'A Sale Made job is always Qualified — it can’t be changed to Not Qualified.'
        : 'This Sale Made entry is marked Not Qualified, which isn’t allowed — a Sale Made job is always Qualified. Change Lead to Qualified to save it.',
    };
  }

  if (leadChanged && (links.openFollowUp || links.convertedLater)) {
    const what = [links.openFollowUp && 'an open follow-up', links.convertedLater && 'a Quote Approved Later (Converted Later) sale']
      .filter(Boolean)
      .join(' and ');
    return {
      status: 409,
      error: `Lead Qualification can’t be changed on this job because it has ${what}. Changing it would affect that ${
        links.openFollowUp && links.convertedLater ? 'follow-up and conversion link' : links.openFollowUp ? 'follow-up' : 'conversion link'
      }, so it needs to be resolved separately first. Nothing was changed.`,
    };
  }

  const values = {
    inspection_sheet: next.inspection_sheet,
    option_sheet: next.option_sheet,
    knockback_reason_id: next.knockback_reason_id,
    knockback: existing.knockback,
  };

  if (!isSaleMade && next.lead === 'Not Qualified') {
    // Changing to Not Qualified: sheets become N/A (the form confirms first
    // if that replaces a Yes/No) and the knock-back reason must be cleared.
    // Already Not Qualified: an older record's Yes/No is left as it is, but
    // a sheet can't newly be set to Yes/No.
    for (const [key, label] of [['inspection_sheet', 'Inspection Sheet'], ['option_sheet', 'Option Sheet']]) {
      const changed = next[key] !== existing[key];
      if ((leadChanged || changed) && !isBlankOrNA(next[key])) {
        return { status: 400, error: `${label} is N/A on a Not Qualified No Sale job.` };
      }
      if (leadChanged) values[key] = NA;
    }
    if (next.knockback_reason_id && (leadChanged || String(next.knockback_reason_id) !== String(existing.knockback_reason_id ?? ''))) {
      return { status: 400, error: 'A Not Qualified No Sale job isn’t a knock-back, so it can’t have a Reason for Knockback.' };
    }
  }

  if (!isSaleMade && next.lead === 'Qualified' && leadChanged && !next.knockback_reason_id) {
    return { status: 400, error: 'This job is now a Qualified No Sale (a knock-back) — please select a Reason for Knockback before saving.' };
  }

  // Recalculated only when Lead actually changes, so an edit that leaves
  // Lead alone never reinterprets an older record.
  if (leadChanged) values.knockback = !isSaleMade && next.lead === 'Qualified' ? 1 : 0;
  return { values };
}

/** How the Knock back column reads in history views and exports. */
export function knockbackLabel(entry) {
  if (entry.kind === 'new_job_no_sale' && entry.lead === 'Not Qualified') return NA;
  return entry.knockback ? 'Yes' : 'No';
}
