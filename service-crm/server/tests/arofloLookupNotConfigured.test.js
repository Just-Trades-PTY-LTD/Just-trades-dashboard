import test from 'node:test';
import assert from 'node:assert/strict';

// Deliberately does NOT set AROFLO_PAT — a separate process/file from
// arofloLookupRoute.test.js precisely so this never picks up that file's
// token (config.js is only ever evaluated once per process).
const { startTestServer } = await import('./helpers.js');

test('AroFlo not configured: the New Job lookup reports itself unavailable, never an error that blocks manual entry', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const res = await server.request('GET', '/aroflo/lookup?jn=1234');
    assert.equal(res.status, 200);
    assert.equal(res.data.found, false);
    assert.match(res.data.message, /not currently configured/);
  } finally {
    server.close();
  }
});
