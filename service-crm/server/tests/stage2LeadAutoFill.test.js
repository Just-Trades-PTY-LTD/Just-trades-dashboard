import test from 'node:test';
import assert from 'node:assert/strict';
import { callLookupSummary, leadSourceDecision, planLeadCallFill, leadCallFillConfirmation } from '../../client/src/lib/arofloCallSuggest.js';
import { nextLookupFill } from '../../client/src/lib/lookupFill.js';

// Stage 2: a booked Lead call's automatic lookup fills BLANK Suburb,
// Trade / Job type and — once the customer-history check is done — Lead
// Source, in the agreed order. Pure form logic: nothing is saved.
const TRADES = [{ id: 1, name: 'Electrical', jobTypes: [{ id: 11, name: 'Power Points' }, { id: 12, name: 'Lighting' }] }];
const SOURCES = [{ id: 7, name: 'Flyer/Magnet' }, { id: 8, name: 'Repeat customer' }, { id: 9, name: 'Google' }];
const blank = { callType: 'Lead', booked: 'Yes', jobNumber: '2727', suburb: '', tradeId: '', jobTypeId: '', leadSourceId: '' };
const result = (over = {}) => ({
  found: true,
  status: 'PENDING',
  suburb: 'Kilburn (5084)',
  taskType: 'Power Points',
  taskTypeMatch: { kind: 'full', tradeId: 1, jobTypeId: 11, label: 'Electrical — Power Points' },
  leadSource: 'Flyer',
  leadSourceMatch: { kind: 'mapped', leadSourceId: 7, label: 'Flyer/Magnet', values: [{ field: 'Lead Source', value: 'Flyer' }] },
  ...over,
});
const plan = (res, history, form = blank) => {
  const summary = callLookupSummary(res, form, { trades: TRADES, leadSources: SOURCES });
  const decision = summary.found ? leadSourceDecision(summary.leadSource, history, form, SOURCES) : null;
  return planLeadCallFill({ summary, decision, form }).wanted;
};
const done = (r) => ({ jn: '2727', status: 'done', result: { found: true, ...r } });

test('no earlier completed work -> Suburb, Trade / Job type and the mapped Lead Source are filled', () => {
  assert.deepEqual(plan(result(), done({ kind: 'no-earlier', warnings: [] })), { suburb: 'Kilburn (5084)', tradeId: 1, jobTypeId: 11, leadSourceId: 7 });
});

test('Lead Source waits for the history check; callback -> none; repeat -> Repeat customer; uncertain or unavailable -> none', () => {
  const base = { suburb: 'Kilburn (5084)', tradeId: 1, jobTypeId: 11 };
  assert.deepEqual(plan(result(), null), base, 'no history yet: not filled');
  assert.deepEqual(plan(result(), { jn: '2727', status: 'checking' }), base, 'still checking: not filled');
  assert.deepEqual(plan(result(), done({ kind: 'callback', reasons: ['its AroFlo task type is Call Back'] })), base);
  assert.deepEqual(plan(result(), done({ kind: 'repeat', earlierJob: { jobNumber: 2602 } })), { ...base, leadSourceId: 8 });
  assert.deepEqual(plan(result(), done({ kind: 'uncertain', reasons: ['possible duplicate'] })), base);
  assert.deepEqual(plan(result(), done({ kind: 'unavailable' })), base, 'history check failed: left for staff');
  assert.deepEqual(plan(result(), { jn: '2727', status: 'done', result: { found: false, kind: 'unavailable' } }), base);
});

test('unmapped or conflicting AroFlo Lead Source, Call Back task type, Trade-only match, no suburb', () => {
  const noEarlier = done({ kind: 'no-earlier', warnings: [] });
  assert.equal(plan(result({ leadSourceMatch: { kind: 'unmapped', values: [{ value: 'Online Ad' }] } }), noEarlier).leadSourceId, undefined);
  assert.equal(plan(result({ leadSourceMatch: { kind: 'conflict', values: [{ value: 'Google' }, { value: 'Flyer' }] } }), noEarlier).leadSourceId, undefined);
  const cb = plan(result({ taskType: 'Call Back', taskTypeMatch: { kind: 'callback' } }), noEarlier);
  assert.ok(!('tradeId' in cb) && !('jobTypeId' in cb), 'never guessed from Call Back');
  const tradeOnly = plan(result({ taskTypeMatch: { kind: 'tradeOnly', tradeId: 1, label: 'Electrical', choices: [{ name: 'Power Points' }, { name: 'Lighting' }] } }), noEarlier);
  assert.deepEqual([tradeOnly.tradeId, tradeOnly.jobTypeId], [1, undefined]);
  assert.equal(plan(result({ suburb: null }), noEarlier).suburb, undefined);
});

test('a staff choice is never replaced; not found fills nothing', () => {
  const noEarlier = done({ kind: 'no-earlier', warnings: [] });
  const staff = { ...blank, suburb: 'Prospect (5082)', tradeId: 2, jobTypeId: '', leadSourceId: 9 };
  assert.deepEqual(plan(result(), noEarlier, staff), {});
  assert.deepEqual(plan({ found: false, message: 'No AroFlo job found with Job Number 2727.' }, noEarlier), {});
});

test('follows the Job Number: fills are taken back for another Job Number unless staff changed them', () => {
  const { patch, filled } = nextLookupFill(blank, {}, { suburb: 'Kilburn (5084)', tradeId: 1, jobTypeId: 11, leadSourceId: 7 });
  assert.equal(leadCallFillConfirmation(filled), 'Filled from AroFlo: Suburb, Trade, Job type, Lead Source — still editable, check before saving.');
  const form = { ...blank, ...patch, leadSourceId: 9 }; // staff changed the Lead Source
  assert.deepEqual(nextLookupFill(form, filled, {}).patch, { suburb: '', tradeId: '', jobTypeId: '' });
  assert.equal(leadCallFillConfirmation({}), null);
});
