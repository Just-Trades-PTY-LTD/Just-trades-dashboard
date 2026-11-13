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
