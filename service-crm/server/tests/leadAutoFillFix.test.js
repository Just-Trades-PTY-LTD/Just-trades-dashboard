import test from 'node:test';
import assert from 'node:assert/strict';
import { leadAutoFillAllowed, withTimeout } from '../../client/src/lib/arofloCallSuggest.js';

// Lead call auto-fill correction: when a saved call may fill blank fields,
// and the timeout that keeps the form from getting stuck.
test('auto-fill allowed for a new call, or a saved call that had no Job Number; "Use this" only when it already had one', () => {
  assert.equal(leadAutoFillAllowed(null), true, 'new call');
  assert.equal(leadAutoFillAllowed({ id: 793, jobNumber: '' }), true, 'saved call, Job Number added now');
  assert.equal(leadAutoFillAllowed({ id: 793, jobNumber: '  ' }), true);
  assert.equal(leadAutoFillAllowed({ id: 793, jobNumber: '2742' }), false, 'already had a Job Number: suggestions only');
});

test('withTimeout: the real answer when it comes in time; the fallback (so Save re-enables) when it does not', async () => {
  assert.equal(await withTimeout(Promise.resolve('answer'), 50, 'fallback'), 'answer');
  const slow = new Promise((r) => setTimeout(() => r('late'), 200));
  assert.equal(await withTimeout(slow, 20, 'fallback'), 'fallback');
});
