import test from 'node:test';
import assert from 'node:assert/strict';

// The client's "auto-fill follows the Job Number" rule
// (client/src/lib/lookupFill.js) — plain JS, tested alongside the server
// suite like the client's other pure helpers.
import { nextLookupFill } from '../../client/src/lib/lookupFill.js';

const blank = { creditedTechnicianId: '', tradeId: '', jobTypeId: '', suburb: '' };
const jobA = { creditedTechnicianId: 7, tradeId: 1, jobTypeId: 11, suburb: 'Woodcroft (5162)' };
const jobB = { creditedTechnicianId: 9, tradeId: 2, jobTypeId: 22, suburb: 'Blackwood (5051)' };

test('first lookup fills blank fields, exactly as before', () => {
  assert.deepEqual(nextLookupFill(blank, {}, jobA), { patch: jobA, filled: jobA });
});

test("correcting the Job Number replaces the old job's values with the new job's", () => {
  const afterA = { ...blank, ...jobA };
  assert.deepEqual(nextLookupFill(afterA, jobA, jobB), { patch: jobB, filled: jobB });
});

test("a corrected Job Number with no match takes the old job's values back out", () => {
  const afterA = { ...blank, ...jobA };
  assert.deepEqual(nextLookupFill(afterA, jobA, {}), {
    patch: { creditedTechnicianId: '', tradeId: '', jobTypeId: '', suburb: '' },
    filled: {},
  });
});

test('anything staff changed after it was filled is never touched', () => {
  const edited = { ...blank, ...jobA, creditedTechnicianId: 3, suburb: 'Typed by staff' };
  const { patch, filled } = nextLookupFill(edited, jobA, jobB);
  assert.deepEqual(patch, { tradeId: 2, jobTypeId: 22 });
  assert.equal(patch.creditedTechnicianId, undefined);
  assert.equal(patch.suburb, undefined);
  assert.deepEqual(filled, { tradeId: 2, jobTypeId: 22 });
});

test('values already on the form that this lookup never filled (typed, or a saved record) are never touched', () => {
  const saved = { ...blank, creditedTechnicianId: 4, tradeId: 1, jobTypeId: 11, suburb: 'Saved suburb' };
  assert.deepEqual(nextLookupFill(saved, {}, jobB), { patch: {}, filled: {} });
  assert.deepEqual(nextLookupFill(saved, {}, {}), { patch: {}, filled: {} });
});

test('the same result arriving again changes nothing', () => {
  const afterA = { ...blank, ...jobA };
  assert.deepEqual(nextLookupFill(afterA, jobA, jobA), { patch: {}, filled: jobA });
});

test("blank values in a result don't clear anything or count as filled", () => {
  const { patch, filled } = nextLookupFill(blank, {}, { tradeId: 1, jobTypeId: null, suburb: '' , creditedTechnicianId: undefined });
  assert.deepEqual(patch, { tradeId: 1 });
  assert.deepEqual(filled, { tradeId: 1 });
});

test('a partial Job Number match (typing 104 on the way to 10432) no longer sticks', () => {
  let form = { ...blank };
  let prev = {};
  for (const wanted of [jobA /* "104" matched another job */, {} /* "1043" no match */, jobB /* "10432" */]) {
    const { patch, filled } = nextLookupFill(form, prev, wanted);
    form = { ...form, ...patch };
    prev = filled;
  }
  assert.deepEqual(form, { ...blank, ...jobB });
});
