import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { versionFromIndexHtml } from '../src/lib/appVersion.js';
import { versionFromUrl, isNewerVersion, VERSION_CHECK_EVERY_MS, VERSION_CHECK_MIN_GAP_MS } from '../../client/src/lib/appVersion.js';
import { setUnsaved, hasUnsavedChanges } from '../../client/src/lib/unsavedChanges.js';

// "A new CRM version is available": the deployed version vs the one an open
// tab is running. Read-only — no database or record is involved.
test('deployed version = the built main script; the tab\'s own = the script it loaded', () => {
  assert.equal(versionFromIndexHtml('<script type="module" crossorigin src="/assets/index-CThnbxcP.js"></script>'), 'index-CThnbxcP.js');
  assert.equal(versionFromIndexHtml('<html>dev</html>'), null);
  assert.equal(versionFromUrl('https://crm.example/assets/index-CThnbxcP.js'), 'index-CThnbxcP.js');
  assert.equal(versionFromUrl('http://localhost:5173/src/components/NewVersionNotice.jsx'), null, 'development: nothing to compare');
});

test('only a real, different deployed version shows the notice', () => {
  assert.equal(isNewerVersion('index-A.js', 'index-B.js'), true);
  assert.equal(isNewerVersion('index-A.js', 'index-A.js'), false);
  assert.equal(isNewerVersion('index-A.js', null), false, 'check failed / no build');
  assert.equal(isNewerVersion(null, 'index-B.js'), false, 'development');
  assert.deepEqual([VERSION_CHECK_EVERY_MS, VERSION_CHECK_MIN_GAP_MS], [600000, 60000]);
});

test('unsaved changes: any open form marked dirty warns; cleared when saved, reset or closed', () => {
  assert.equal(hasUnsavedChanges(), false);
  setUnsaved('log-call', true);
  setUnsaved('log-entry', true);
  setUnsaved('log-call', false);
  assert.equal(hasUnsavedChanges(), true, 'the other form still has changes');
  setUnsaved('log-entry', false);
  assert.equal(hasUnsavedChanges(), false);
});

test('GET /api/version answers without signing in', async () => {
  const server = await startTestServer();
  try {
    const r = await server.request('GET', '/version');
    assert.equal(r.status, 200);
    assert.ok('version' in r.data);
  } finally {
    server.close();
  }
});

// App-wide unsaved-changes tracking, with stand-in form fields.
import { isTrackable, installUnsavedChangesTracking, markAllSaved } from '../../client/src/lib/unsavedChanges.js';

function fakeDoc() {
  const handlers = {};
  return { addEventListener: (ev, fn) => ((handlers[ev] = handlers[ev] || []).push(fn)), fire: (ev, target) => (handlers[ev] || []).forEach((fn) => fn({ target })) };
}
const field = (over = {}) => ({ tagName: 'INPUT', type: 'text', value: '', checked: false, isConnected: true, disabled: false, readOnly: false, closest: () => null, ...over });

test('what counts: text, dropdowns, dates, checkboxes — not buttons, search boxes, disabled fields or marked filter areas', () => {
  assert.equal(isTrackable(field()), true);
  assert.equal(isTrackable(field({ tagName: 'TEXTAREA' })), true);
  assert.equal(isTrackable(field({ tagName: 'SELECT' })), true);
  assert.equal(isTrackable(field({ type: 'checkbox' })), true);
  assert.equal(isTrackable(field({ type: 'submit' })), false);
  assert.equal(isTrackable(field({ type: 'search' })), false);
  assert.equal(isTrackable(field({ disabled: true })), false);
  assert.equal(isTrackable(field({ closest: (sel) => (sel === '[data-unsaved-ignore]' ? {} : null) })), false, 'filters / reports');
  assert.equal(isTrackable({ tagName: 'DIV' }), false);
});

test('any screen: a changed field is unsaved until a save succeeds; changing it back, or leaving the screen, clears it', () => {
  const doc = fakeDoc();
  installUnsavedChangesTracking(doc);
  const note = field({ value: '' });
  doc.fire('focusin', note);
  note.value = 'Rang the customer';
  doc.fire('input', note);
  assert.equal(hasUnsavedChanges(), true);
  note.value = '';
  assert.equal(hasUnsavedChanges(), false, 'typed then removed: nothing unsaved');
  note.value = 'Rang again';
  doc.fire('input', note);
  markAllSaved();
  assert.equal(hasUnsavedChanges(), false, 'saved');
  const box = field({ type: 'checkbox', checked: false });
  doc.fire('pointerdown', box);
  box.checked = true;
  doc.fire('change', box);
  assert.equal(hasUnsavedChanges(), true);
  box.isConnected = false;
  assert.equal(hasUnsavedChanges(), false, 'that screen was closed');
  const filter = field({ closest: () => ({}) });
  doc.fire('focusin', filter);
  filter.value = '2742';
  doc.fire('input', filter);
  assert.equal(hasUnsavedChanges(), false, 'a filter never counts');
});
