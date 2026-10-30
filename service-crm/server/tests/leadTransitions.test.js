import test from 'node:test';
import assert from 'node:assert/strict';

// The Technician & Sales form's Lead / entry-type transitions
// (client/src/lib/leadTransitions.js) — plain JS, tested alongside the
// server suite like the client's other pure helpers.
import { changeLead, switchNewJobKind, hasEnteredDetails } from '../../client/src/lib/leadTransitions.js';

const emptyForm = (kind) => ({
  kind: kind || '',
  visitDate: '2026-05-01',
  dateLogged: '2026-05-01',
  jobNumber: '',
  technicianId: '',
  lead: kind === 'new_job_sale_made' ? 'Qualified' : '',
  inspectionSheet: '',
  optionSheet: '',
  knockbackReasonId: '',
  invoiceNumber: '',
  invoiceDate: '2026-05-01',
  saleValueExGst: '',
  workCompletion: '',
  installTechnicianId: '',
  installDate: '',
  comments: '',
  followUpRequired: false,
  followUpDueDate: '',
});
const noSale = (over = {}) => ({ ...emptyForm('new_job_no_sale'), jobNumber: '2572', technicianId: 3, ...over });

test('Qualified -> Not Qualified with nothing entered: sheets N/A, no confirmation needed', () => {
  const { next, lost } = changeLead(noSale({ lead: 'Qualified' }), 'Not Qualified');
  assert.deepEqual(lost, []);
  assert.deepEqual([next.lead, next.inspectionSheet, next.optionSheet, next.knockbackReasonId], ['Not Qualified', 'N/A', 'N/A', '']);
  assert.equal(next.jobNumber, '2572', 'everything else kept');
});

test('Qualified -> Not Qualified that replaces answers lists every one for confirmation', () => {
  const { next, lost } = changeLead(
    noSale({ lead: 'Qualified', inspectionSheet: 'Yes', optionSheet: 'No', knockbackReasonId: 5, followUpRequired: true, followUpDueDate: '2026-05-11' }),
    'Not Qualified',
    { reasonName: 'Price' },
  );
  assert.equal(lost.length, 4);
  assert.match(lost.join(' | '), /Inspection Sheet \(currently Yes\).*Option Sheet \(currently No\).*Reason for knock back \(Price\).*follow-up reminder/);
  assert.deepEqual([next.inspectionSheet, next.optionSheet, next.knockbackReasonId, next.followUpRequired], ['N/A', 'N/A', '', false]);
});

test('Not Qualified -> Qualified returns the automatic N/A to normal selection', () => {
  const { next, lost } = changeLead(noSale({ lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' }), 'Qualified');
  assert.deepEqual(lost, []);
  assert.deepEqual([next.lead, next.inspectionSheet, next.optionSheet], ['Qualified', '', '']);
});

test('an older Not Qualified record with Yes/No keeps its answers when re-qualified', () => {
  const { next } = changeLead(noSale({ lead: 'Not Qualified', inspectionSheet: 'No', optionSheet: 'N/A' }), 'Qualified');
  assert.deepEqual([next.inspectionSheet, next.optionSheet], ['No', '']);
});

test('Lead changes on Sale Made, or not involving Not Qualified, change only Lead', () => {
  const f = { ...emptyForm('new_job_sale_made'), inspectionSheet: 'Yes' };
  assert.deepEqual(changeLead(f, 'Qualified'), { lost: [], next: { ...f, lead: 'Qualified' } });
  const q = noSale({ lead: '', inspectionSheet: 'Yes' });
  assert.deepEqual(changeLead(q, 'Qualified').next, { ...q, lead: 'Qualified' });
});

test('Not Qualified No Sale -> Sale Made: Lead becomes Qualified, N/A returns to normal, shared details kept', () => {
  const f = noSale({ lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', comments: 'typed' });
  const { next, lost } = switchNewJobKind(f, 'new_job_sale_made', { emptyForm });
  assert.equal(lost.length, 1);
  assert.match(lost[0], /Not Qualified to Qualified/);
  assert.deepEqual([next.kind, next.lead, next.inspectionSheet, next.optionSheet], ['new_job_sale_made', 'Qualified', '', '']);
  assert.deepEqual([next.jobNumber, next.technicianId, next.comments], ['2572', 3, 'typed']);
});

test('Qualified No Sale -> Sale Made keeps Yes/No answers; a knock-back reason needs confirming', () => {
  const f = noSale({ lead: 'Qualified', inspectionSheet: 'Yes', optionSheet: 'No', knockbackReasonId: 5 });
  const { next, lost } = switchNewJobKind(f, 'new_job_sale_made', { emptyForm, reasonName: 'Price' });
  assert.deepEqual(lost, ['Reason for knock back (Price) will be cleared']);
  assert.deepEqual([next.inspectionSheet, next.optionSheet, next.knockbackReasonId, next.lead], ['Yes', 'No', '', 'Qualified']);
});

test('Sale Made -> No Sale lists the sale details it would clear, keeps everything shared', () => {
  const f = { ...emptyForm('new_job_sale_made'), jobNumber: '2572', invoiceNumber: 'INV-1', saleValueExGst: 500, workCompletion: 'Same day' };
  const { next, lost } = switchNewJobKind(f, 'new_job_no_sale', { emptyForm });
  assert.equal(lost.length, 3);
  assert.deepEqual([next.kind, next.jobNumber, next.lead, next.invoiceNumber, next.saleValueExGst], ['new_job_no_sale', '2572', 'Qualified', '', '']);
  const clean = { ...emptyForm('new_job_sale_made'), jobNumber: '2572' };
  assert.deepEqual(switchNewJobKind(clean, 'new_job_no_sale', { emptyForm }).lost, [], 'nothing to confirm when no sale details entered');
});

test('only No Sale <-> Sale Made is a keep-the-details switch', () => {
  assert.equal(switchNewJobKind(noSale(), 'call_back', { emptyForm }), null);
  assert.equal(switchNewJobKind(noSale(), 'new_job_no_sale', { emptyForm }), null);
  assert.equal(switchNewJobKind({ ...emptyForm('call_back') }, 'new_job_no_sale', { emptyForm }), null);
});

test('any other switch asks first only if staff have entered something', () => {
  assert.equal(hasEnteredDetails(emptyForm('new_job_no_sale'), emptyForm), false, 'default dates do not count');
  assert.equal(hasEnteredDetails(emptyForm(''), emptyForm), false, 'no entry type chosen yet');
  assert.equal(hasEnteredDetails(emptyForm('new_job_sale_made'), emptyForm), false, 'the automatic Qualified does not count');
  assert.equal(hasEnteredDetails(noSale(), emptyForm), true);
});
