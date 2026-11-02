import test from 'node:test';
import assert from 'node:assert/strict';

// "Look up in AroFlo" on a Lead call (client/src/lib/arofloCallSuggest.js):
// suggestions only on a single exact-name match, never a guess.
import { matchJobType, matchLeadSource, callLookupSummary } from '../../client/src/lib/arofloCallSuggest.js';

const trades = [
  { id: 1, name: 'Plumbing', jobTypes: [{ id: 11, name: 'Hot water unit' }, { id: 12, name: 'Blocked drain' }, { id: 13, name: 'Service' }] },
  { id: 2, name: 'Electrical', jobTypes: [{ id: 21, name: 'Switchboard' }, { id: 22, name: 'Service' }] },
];
const leadSources = [
  { id: 101, name: 'Google search' },
  { id: 102, name: 'Google ads' },
  { id: 103, name: 'Facebook' },
  { id: 104, name: 'Word of mouth' },
];

test('job type: a single exact-name match (ignoring case/punctuation, or "Trade Job type") is suggested', () => {
  assert.deepEqual(matchJobType('HOT WATER UNIT', trades), { tradeId: 1, jobTypeId: 11, label: 'Plumbing — Hot water unit' });
  assert.deepEqual(matchJobType('Blocked-Drain', trades), { tradeId: 1, jobTypeId: 12, label: 'Plumbing — Blocked drain' });
  assert.deepEqual(matchJobType('Electrical - Service', trades), { tradeId: 2, jobTypeId: 22, label: 'Electrical — Service' });
});

test('job type: ambiguous, partial or missing names suggest nothing', () => {
  assert.equal(matchJobType('Service', trades), null, 'two trades have "Service" — never guessed');
  assert.equal(matchJobType('Hot water', trades), null, 'partial name is not a match');
  assert.equal(matchJobType('Gas fitting', trades), null);
  assert.equal(matchJobType('', trades), null);
  assert.equal(matchJobType(undefined, trades), null);
});

test('lead source: exact single match only; AroFlo "Google" is never guessed as search or ads', () => {
  assert.deepEqual(matchLeadSource('facebook', leadSources), { leadSourceId: 103, label: 'Facebook' });
  assert.deepEqual(matchLeadSource('Word-of-Mouth', leadSources), { leadSourceId: 104, label: 'Word of mouth' });
  assert.equal(matchLeadSource('Google', leadSources), null);
  assert.equal(matchLeadSource('', leadSources), null);
});

test('summary: not found shows the reason; found shows values, suggestions and whether already selected', () => {
  assert.deepEqual(callLookupSummary({ found: false, message: 'No matching AroFlo job found for "2440".' }, {}, { trades, leadSources }), {
    found: false,
    message: 'No matching AroFlo job found for "2440".',
  });
  assert.equal(callLookupSummary(null, {}, { trades, leadSources }).found, false);

  const result = { found: true, status: 'PENDING', taskType: 'Hot Water Unit', leadSource: 'Google' };
  const s = callLookupSummary(result, { tradeId: '', jobTypeId: '', leadSourceId: '' }, { trades, leadSources });
  assert.equal(s.status, 'PENDING');
  assert.deepEqual(s.jobType, { arofloValue: 'Hot Water Unit', suggestion: { tradeId: 1, jobTypeId: 11, label: 'Plumbing — Hot water unit' }, alreadySet: false });
  assert.deepEqual(s.leadSource, { arofloValue: 'Google', suggestion: null, alreadySet: false });

  const set = callLookupSummary({ ...result, leadSource: 'Facebook' }, { tradeId: '1', jobTypeId: '11', leadSourceId: '103' }, { trades, leadSources });
  assert.equal(set.jobType.alreadySet, true);
  assert.equal(set.leadSource.alreadySet, true);
});
