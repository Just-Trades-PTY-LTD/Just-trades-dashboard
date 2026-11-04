import test from 'node:test';
import assert from 'node:assert/strict';

// Automatic AroFlo prefill for a new, unsaved New Job entry
// (client/src/lib/arofloPrefill.js): blank fields only, one reliable match
// only, Adelaide dates, and a new Job Number takes back only what the
// lookup filled.
import {
  revertPrefill,
  prefillStep,
  matchTechnician,
  COMPLETED_ON_VISIT,
  DIFFERENT_DAY,
} from '../../client/src/lib/arofloPrefill.js';

const trades = [
  { id: 1, name: 'Plumbing', jobTypes: [{ id: 11, name: 'Hot water unit' }, { id: 12, name: 'Other' }] },
  { id: 2, name: 'Electrical', jobTypes: [{ id: 21, name: 'Switchboard' }, { id: 22, name: 'Other' }] },
];
const technicians = [
  { id: 5, name: 'Ryan Smith', active: true },
  { id: 6, name: 'Cody Walker', active: true },
  { id: 7, name: 'Old Tech', active: false },
];
const now = { date: '2026-11-04', time: '10:00' };
const TODAY = '2026-11-04';
const defaults = { invoiceDate: TODAY };
const blank = (kind = 'new_job_sale_made', over = {}) => ({
  kind, visitDate: '2026-11-03', suburb: '', comments: '', tradeId: '', jobTypeId: '', technicianId: '',
  invoiceNumber: '', invoiceDate: TODAY, saleValueExGst: '', workCompletion: '', installDate: '', installTechnicianId: '',
  lead: 'Qualified', inspectionSheet: '', optionSheet: '', ...over,
});
const result = (over = {}) => ({
  found: true, status: 'COMPLETED', taskType: 'Hot Water Unit', description: 'Replace HWS', suburb: 'Woodcroft (5162)',
  invoices: [{ invoiceNumber: '2115', invoiceDate: '2026-11-03', saleValueExGst: 4757, status: 'IN_PROGRESS' }],
  activity: { labour: [{ technician: 'Ryan Smith', date: '2026-11-03' }], visits: [] },
  ...over,
});
const run = (res, form = blank(), previous = {}) => {
  const { plan, patch, filled } = prefillStep({ result: res, form, previous, now, trades, technicians, defaults });
  return { plan, patch, filled, form: { ...form, ...patch } };
};

test('exact matches on a blank Sale Made form: suburb, comments, trade/job type, single invoice, completed on this visit', () => {
  const { patch, plan } = run(result());
  assert.deepEqual(patch, {
    suburb: 'Woodcroft (5162)', comments: 'Replace HWS', tradeId: '1', jobTypeId: '11',
    invoiceNumber: '2115', invoiceDate: '2026-11-03', saleValueExGst: 4757, workCompletion: COMPLETED_ON_VISIT,
  });
  assert.deepEqual(plan.suggestions, []);
  assert.ok(!('technicianId' in patch), 'the visit / credited technician is never filled from AroFlo');
  assert.ok(!('lead' in patch) && !('inspectionSheet' in patch) && !('optionSheet' in patch), 'qualification and sheets are never touched');
});

test('No Sale: never gets invoice or work completion', () => {
  const { patch } = run(result(), blank('new_job_no_sale', { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' }));
  assert.deepEqual(Object.keys(patch).sort(), ['comments', 'jobTypeId', 'suburb', 'tradeId']);
});

test('no matches: unmatched or ambiguous task type, no suburb, no invoice — fields left blank with a note', () => {
  const { patch, plan } = run(result({ taskType: 'Other', suburb: null, invoices: [] }));
  assert.ok(!('tradeId' in patch) && !('suburb' in patch) && !('invoiceNumber' in patch));
  const notes = plan.notes.join(' ');
  assert.match(notes, /doesn't match exactly one Trade/);
  assert.match(notes, /suburb/);
  assert.match(notes, /No invoice found/);
});

test('AroFlo unavailable / not found: nothing filled', () => {
  for (const r of [{ found: false, message: 'AroFlo could not be reached' }, null]) {
    const { patch, plan } = run(r);
    assert.deepEqual(patch, {});
    assert.deepEqual(plan.wanted, {});
  }
});

test('multiple invoices: none chosen automatically', () => {
  const inv = result().invoices[0];
  const { patch, plan } = run(result({ invoices: [inv, { ...inv, invoiceNumber: '2116', saleValueExGst: 300 }] }));
  assert.ok(!('invoiceNumber' in patch) && !('saleValueExGst' in patch));
  assert.match(plan.notes.join(' '), /2 invoices/);
});

test('one future visit with one matching technician: different day, date and install technician (never the credited technician)', () => {
  const { patch } = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan Smith El Install', date: '2026-11-10', start: '08:00' }] } }));
  assert.equal(patch.workCompletion, DIFFERENT_DAY);
  assert.equal(patch.installDate, '2026-11-10');
  assert.equal(patch.installTechnicianId, '5');
  assert.ok(!('technicianId' in patch) && !('creditedTechnicianId' in patch));
});

test('multiple future visits on different dates: nothing chosen', () => {
  const { patch, plan } = run(result({ status: 'PENDING', activity: { labour: [], visits: [
    { technician: 'Ryan Smith', date: '2026-11-10', start: '08:00' }, { technician: 'Ryan Smith', date: '2026-11-12', start: '08:00' },
  ] } }));
  assert.ok(!('workCompletion' in patch) && !('installDate' in patch));
  assert.match(plan.notes.join(' '), /2 different future dates/);
});

test('multiple technicians on the one future visit, or no confident match: date filled, install technician left', () => {
  const two = run(result({ status: 'PENDING', activity: { labour: [], visits: [
    { technician: 'Ryan Smith', date: '2026-11-10', start: '08:00' }, { technician: 'Cody Walker', date: '2026-11-10', start: '08:00' },
  ] } }));
  assert.deepEqual([two.patch.workCompletion, two.patch.installDate, two.patch.installTechnicianId], [DIFFERENT_DAY, '2026-11-10', undefined]);
  assert.match(two.plan.notes.join(' '), /2 people booked/);
  const similar = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan S El Install', date: '2026-11-10', start: '08:00' }] } }));
  assert.equal(similar.patch.installTechnicianId, undefined, 'a similar name is never guessed');
  assert.equal(matchTechnician('Old Tech Install', technicians), null, 'inactive technicians are never matched');
});

test('past visits, visits on the original visit date, and later-today visits are handled in Adelaide time', () => {
  const past = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan Smith', date: '2026-11-02', start: '08:00' }] } }));
  assert.ok(!('workCompletion' in past.patch), 'a past visit is not a future booking; a pending job without one is left for staff');
  const laterToday = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan Smith', date: TODAY, start: '14:00' }] } }));
  assert.equal(laterToday.patch.installDate, TODAY);
  const earlierToday = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan Smith', date: TODAY, start: '07:00' }] } }));
  assert.ok(!('workCompletion' in earlierToday.patch));
});

test('completed with no future visit but time logged on a later day, unreadable visits or labour: left for staff', () => {
  const later = run(result({ activity: { labour: [{ date: '2026-11-03' }, { date: '2026-11-04' }], visits: [] } }));
  assert.ok(!('workCompletion' in later.patch));
  assert.match(later.plan.notes.join(' '), /later day/);
  assert.ok(!('workCompletion' in run(result({ activity: { labour: [], visits: null } })).patch));
  assert.ok(!('workCompletion' in run(result({ activity: { labour: null, visits: [] } })).patch));
  assert.ok(!('workCompletion' in run(result({ activity: undefined })).patch));
});

test('manually entered values are never overwritten; a different AroFlo value is offered as a suggestion', () => {
  const form = blank('new_job_sale_made', {
    suburb: 'Reynella (5161)', comments: 'typed', tradeId: '2', jobTypeId: '21', invoiceNumber: 'MINE', workCompletion: COMPLETED_ON_VISIT,
  });
  const { patch, plan } = run(result({ status: 'PENDING', activity: { labour: [], visits: [{ technician: 'Ryan Smith', date: '2026-11-10', start: '08:00' }] } }), form);
  assert.deepEqual(patch, {}, 'nothing typed by staff is replaced, and a part-entered invoice blocks the whole invoice');
  const labels = plan.suggestions.map((s) => s.label).join(' | ');
  assert.match(labels, /Suburb: Woodcroft/);
  assert.match(labels, /Trade \/ Job type: Plumbing — Hot water unit/);
  assert.match(labels, /Work completion: Install scheduled — different day on 2026-11-10/);
});

test('changing the Job Number: only values still showing what the lookup filled are taken back', () => {
  const first = run(result());
  const edited = { ...first.form, comments: 'staff rewrote this', invoiceDate: '2026-11-01' };
  const undo = revertPrefill(edited, first.filled);
  assert.deepEqual(undo, {
    suburb: '', tradeId: '', jobTypeId: '', invoiceNumber: '', saleValueExGst: '', workCompletion: '',
  }, 'staff-changed Comments and Invoice date are kept; the rest returns to how it was');
  // A second lookup for a new number fills from the new job after taking back the old one.
  const second = run(result({ suburb: 'Reynella (5161)', invoices: [] }), first.form, first.filled);
  assert.equal(second.form.suburb, 'Reynella (5161)');
  assert.equal(second.form.invoiceNumber, '', "the previous job's invoice is taken back, not carried over");
  assert.equal(second.form.invoiceDate, TODAY, 'invoice date goes back to its default');
  // Retrying the lookup for the same number refills the same values (nothing left blank).
  const retry = run(result(), first.form, first.filled);
  assert.deepEqual(retry.form, first.form);
  assert.deepEqual(retry.filled, first.filled);
});
