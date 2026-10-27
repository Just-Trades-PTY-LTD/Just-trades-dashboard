import test from 'node:test';
import assert from 'node:assert/strict';

// The client's "what may an AroFlo lookup put into the form" rule
// (client/src/lib/arofloFill.js) — plain JS with no React or browser
// dependency, so it's tested here alongside the server suite.
import {
  arofloAutoFill,
  arofloSuburbSuggestion,
  arofloCommentsSuggestion,
} from '../../client/src/lib/arofloFill.js';

const RESULT = { found: true, suburb: 'Woodcroft (5162)', description: 'Split system not cooling' };

test('new entry: suburb applied on a confident match, comments only if blank', () => {
  assert.deepEqual(arofloAutoFill({ result: RESULT, form: { suburb: 'Morphett Vale (5162)', comments: '' }, applySuburb: true, editing: false }), {
    suburb: 'Woodcroft (5162)',
    comments: 'Split system not cooling',
  });
  assert.deepEqual(arofloAutoFill({ result: RESULT, form: { suburb: '', comments: 'Typed by staff' }, applySuburb: true, editing: false }), {
    suburb: 'Woodcroft (5162)',
  });
});

test('new entry without a suburb field never gets one', () => {
  assert.deepEqual(arofloAutoFill({ result: RESULT, form: { comments: 'x' }, applySuburb: false, editing: false }), {});
});

test('editing a saved entry: the lookup never changes any field by itself', () => {
  assert.deepEqual(arofloAutoFill({ result: RESULT, form: { suburb: 'Morphett Vale (5162)', comments: '' }, applySuburb: true, editing: true }), {});
  assert.deepEqual(arofloAutoFill({ result: RESULT, form: { suburb: '', comments: '' }, applySuburb: true, editing: true }), {});
});

test('nothing found means nothing filled or suggested', () => {
  const result = { found: false, message: 'No matching AroFlo job found.' };
  const form = { suburb: '', comments: '' };
  assert.deepEqual(arofloAutoFill({ result, form, applySuburb: true, editing: false }), {});
  assert.equal(arofloSuburbSuggestion({ result, form, editing: true }), null);
  assert.equal(arofloCommentsSuggestion({ result, form, editing: true }), null);
  assert.deepEqual(arofloAutoFill({ result: null, form, applySuburb: true, editing: false }), {});
});

test('editing: suburb offered as a suggestion only when it differs from the form', () => {
  assert.equal(arofloSuburbSuggestion({ result: RESULT, form: { suburb: 'Morphett Vale (5162)' }, editing: true }), 'Woodcroft (5162)');
  assert.equal(arofloSuburbSuggestion({ result: RESULT, form: { suburb: '' }, editing: true }), 'Woodcroft (5162)');
  assert.equal(arofloSuburbSuggestion({ result: RESULT, form: { suburb: 'Woodcroft (5162)' }, editing: true }), null);
  assert.equal(arofloSuburbSuggestion({ result: RESULT, form: { suburb: 'Morphett Vale (5162)' }, editing: false }), null);
});

test('editing: description offered only when Comments is blank', () => {
  assert.equal(arofloCommentsSuggestion({ result: RESULT, form: { comments: '' }, editing: true }), 'Split system not cooling');
  assert.equal(arofloCommentsSuggestion({ result: RESULT, form: { comments: 'Saved comment' }, editing: true }), null);
  assert.equal(arofloCommentsSuggestion({ result: RESULT, form: { comments: '' }, editing: false }), null);
});
