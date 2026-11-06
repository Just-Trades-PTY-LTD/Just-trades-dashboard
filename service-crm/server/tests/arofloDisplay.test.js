import test from 'node:test';
import assert from 'node:assert/strict';

// What the entry form SHOWS after an AroFlo lookup (client/src/lib/arofloDisplay.js):
// one confirmation naming the fields filled, no "Use this" for a value already in
// the form, and read-only visits/time only when AroFlo returned some. Display only.
import {
  filledFieldNames,
  prefillConfirmation,
  invoiceChoices,
  scheduleApplied,
  attendingTechnicianApplied,
  hasActivity,
} from '../../client/src/lib/arofloDisplay.js';
import { prefillStep, DIFFERENT_DAY } from '../../client/src/lib/arofloPrefill.js';

test('confirmation names each filled field once, in form order, without values', () => {
  assert.deepEqual(
    filledFieldNames(['comments', 'saleValueExGst', 'invoiceNumber', 'invoiceDate', 'jobTypeId', 'tradeId', 'suburb', 'workCompletion']),
    ['Suburb', 'Trade / Job type', 'Invoice', 'Work completion', 'Comments']
  );
  assert.deepEqual(filledFieldNames(['workCompletion', 'installDate', 'installTechnicianId']), ['Work completion', 'Install date', 'Install technician']);
  assert.equal(prefillConfirmation(['suburb', 'comments']), 'AroFlo details added — please check before saving: Suburb, Comments.');
  assert.equal(prefillConfirmation([]), null);
  assert.equal(prefillConfirmation(undefined), null);
  assert.doesNotMatch(prefillConfirmation(['suburb', 'invoiceNumber', 'saleValueExGst']), /\$|\d/, 'names only, no values');
});

test('an invoice already in the form is never offered again; other invoices remain genuine choices', () => {
  const result = { found: true, invoices: [{ invoiceNumber: '2190' }, { invoiceNumber: '2191' }, { invoiceNumber: '' }] };
  assert.deepEqual(invoiceChoices(result, { invoiceNumber: '' }).map((i) => i.invoiceNumber), ['2190', '2191'], 'blank invoice number never listed');
  assert.deepEqual(invoiceChoices(result, { invoiceNumber: ' 2190 ' }).map((i) => i.invoiceNumber), ['2191']);
  assert.deepEqual(invoiceChoices({ found: true, invoices: [{ invoiceNumber: '2190' }] }, { invoiceNumber: '2190' }), [], 'applied single invoice: nothing to offer');
  assert.deepEqual(invoiceChoices({ found: true, invoices: [{ invoiceNumber: '2190' }] }, { invoiceNumber: '1999' }).length, 1, 'different manual invoice: AroFlo\'s is offered');
  assert.deepEqual(invoiceChoices({ found: false }, {}), []);
});

test('a scheduled visit or attending technician already applied is not offered again; a conflict is', () => {
  const scheduled = { date: '2026-11-12', technicianName: 'Ryan S', matchedTechnicianId: 7 };
  assert.equal(scheduleApplied(scheduled, { workCompletion: DIFFERENT_DAY, installDate: '2026-11-12', installTechnicianId: '7' }, DIFFERENT_DAY), true);
  assert.equal(scheduleApplied(scheduled, { workCompletion: DIFFERENT_DAY, installDate: '2026-11-13', installTechnicianId: '7' }, DIFFERENT_DAY), false, 'different date');
  assert.equal(scheduleApplied(scheduled, { workCompletion: DIFFERENT_DAY, installDate: '2026-11-12', installTechnicianId: '8' }, DIFFERENT_DAY), false, 'different technician');
  assert.equal(scheduleApplied(scheduled, { workCompletion: '', installDate: '', installTechnicianId: '' }, DIFFERENT_DAY), false, 'not applied yet');
  assert.equal(scheduleApplied({ ...scheduled, matchedTechnicianId: null }, { workCompletion: DIFFERENT_DAY, installDate: '2026-11-12', installTechnicianId: '' }, DIFFERENT_DAY), true, 'unmatched technician: date applied is enough');
  assert.equal(attendingTechnicianApplied(scheduled, { technicianId: '7' }), true);
  assert.equal(attendingTechnicianApplied(scheduled, { technicianId: '' }), false);
});

test('visits and time: shown only when AroFlo returned some', () => {
  assert.equal(hasActivity(null), false);
  assert.equal(hasActivity({ labour: null, visits: null }), false);
  assert.equal(hasActivity({ labour: [], visits: [] }), false);
  assert.equal(hasActivity({ labour: [{ technician: 'Ryan S' }], visits: [] }), true);
  assert.equal(hasActivity({ labour: [], visits: [{ date: '2026-11-12' }] }), true);
});

test('a successful prefill leaves nothing to re-offer: every filled value is already in the form', () => {
  const trades = [{ id: 1, name: 'Plumbing', jobTypes: [{ id: 11, name: 'Hot water' }] }];
  const result = {
    found: true,
    status: 'COMPLETED',
    suburb: 'Prospect (5082)',
    description: 'Replace HWS',
    taskType: 'Plumbing - Hot water',
    invoices: [{ invoiceNumber: '2190', invoiceDate: '2026-11-03', saleValueExGst: 4754 }],
    activity: { visits: [], labour: [{ technician: 'Ryan S', date: '2026-11-03' }] },
  };
  const form = { kind: 'new_job_sale_made', visitDate: '2026-11-03', suburb: '', comments: '', tradeId: '', jobTypeId: '', invoiceNumber: '', invoiceDate: '2026-11-06', saleValueExGst: '', workCompletion: '' };
  const { plan, patch, filled } = prefillStep({ result, form, previous: {}, now: { date: '2026-11-06', time: '09:00' }, trades, technicians: [], defaults: { invoiceDate: '2026-11-06' } });
  const after = { ...form, ...patch };
  assert.equal(plan.suggestions.length, 0, 'no suggestion repeats a filled value');
  assert.deepEqual(invoiceChoices(result, after), [], 'the applied invoice is not offered again');
  assert.match(prefillConfirmation(Object.keys(filled)), /^AroFlo details added — please check before saving: Suburb, .*Invoice.*Comments\.$/);
});
