import test from 'node:test';
import assert from 'node:assert/strict';

// These exercise the Stage 1 investigation probes (aroflo/client.js)
// directly against a stubbed global.fetch — no live AroFlo account
// involved, and no server/DB started. Must set AROFLO_PAT before the
// config/client module graph is first imported, hence the dynamic import
// below rather than a static one (static imports are hoisted ahead of any
// top-level code in an ES module).
process.env.AROFLO_PAT = 'test-token-should-never-appear-in-any-result';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';

const { listTaskTypes, listLocations, listAroFloUsers, probeTaskHistory, probeLocationDetail } = await import('../src/aroflo/client.js');

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = async (url, init) => handler(new URL(url), init);
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

test('a confirmed endpoint (200) is reported as available, with its data intact', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url.pathname, '/v2/tasktypes');
    return jsonResponse(200, { items: [{ id: 1, name: 'Fans' }] });
  });
  try {
    const result = await listTaskTypes('BU-1');
    assert.equal(result.tried, '/tasktypes');
    assert.equal(result.available, true);
    assert.deepEqual(result.data, { items: [{ id: 1, name: 'Fans' }] });
  } finally {
    restore();
  }
});

test('an unconfirmed endpoint (404) is reported as unavailable, never thrown', async () => {
  const restore = stubFetch(async () => jsonResponse(404, { error: 'not found' }));
  try {
    const result = await listLocations('BU-1');
    assert.equal(result.available, false);
    assert.equal(result.status, 404);
    assert.equal(result.note, 'endpoint not found on this account');
  } finally {
    restore();
  }
});

test('listAroFloUsers follows the same available/unavailable shape', async () => {
  const restore = stubFetch(async () => jsonResponse(200, { items: [{ userId: 'U1', name: 'Ryan' }] }));
  try {
    const result = await listAroFloUsers('BU-1');
    assert.equal(result.available, true);
    assert.deepEqual(result.data, { items: [{ userId: 'U1', name: 'Ryan' }] });
  } finally {
    restore();
  }
});

test('probeTaskHistory tries every candidate path sequentially and reports each result independently', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(url.pathname + url.search);
    if (url.pathname.endsWith('/timesheets') && !url.pathname.includes('tasks/')) {
      return jsonResponse(200, { items: [{ userId: 'U1', hours: 4 }] });
    }
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    const results = await probeTaskHistory('BU-1', 'TASK-1');
    assert.equal(results.length, 6, 'tries every candidate, not just the first');
    const tried = results.map((r) => r.tried);
    assert.deepEqual(tried, [
      '/tasks/TASK-1/timesheets',
      '/timesheets',
      '/tasks/TASK-1/schedules',
      '/schedules',
      '/tasks/TASK-1/history',
      '/tasks/TASK-1/activity',
    ]);
    const timesheetsByQuery = results.find((r) => r.tried === '/timesheets');
    assert.equal(timesheetsByQuery.available, true);
    assert.deepEqual(timesheetsByQuery.data, { items: [{ userId: 'U1', hours: 4 }] });
    results
      .filter((r) => r.tried !== '/timesheets')
      .forEach((r) => assert.equal(r.available, false, `${r.tried} should be unavailable`));
    assert.equal(seen.length, 6, 'ran sequentially, not fanned out in parallel beyond the six candidates');
  } finally {
    restore();
  }
});

test('probeLocationDetail is a no-op (no request at all) when there is no location id', async () => {
  const restore = stubFetch(async () => {
    throw new Error('fetch should never be called when locationId is falsy');
  });
  try {
    const result = await probeLocationDetail(null);
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('probeLocationDetail fetches the given id when present', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url.pathname, '/v2/locations/LOC-99');
    return jsonResponse(200, { id: 'LOC-99', suburb: 'Blackwood', postcode: '5051' });
  });
  try {
    const result = await probeLocationDetail('LOC-99');
    assert.equal(result.available, true);
    assert.deepEqual(result.data, { id: 'LOC-99', suburb: 'Blackwood', postcode: '5051' });
  } finally {
    restore();
  }
});

test('a network failure never leaks the token or the raw underlying error into the probe result', async () => {
  const restore = stubFetch(async () => {
    throw new Error('ECONNRESET while sending Authorization: Bearer test-token-should-never-appear-in-any-result');
  });
  try {
    const result = await listTaskTypes('BU-1');
    assert.equal(result.available, false);
    assert.equal(result.status, 0);
    assert.equal(result.note, 'request failed');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('test-token-should-never-appear-in-any-result'), 'token must never appear in the result');
    assert.ok(!serialized.includes('ECONNRESET'), 'the raw underlying error must never appear in the result');
  } finally {
    restore();
  }
});

test('every outgoing probe request actually carries the Bearer token (to AroFlo itself, never echoed back)', async () => {
  let capturedAuth = null;
  const restore = stubFetch(async (url, init) => {
    capturedAuth = init.headers.Authorization;
    return jsonResponse(200, { items: [] });
  });
  try {
    await listTaskTypes('BU-1');
    assert.equal(capturedAuth, 'Bearer test-token-should-never-appear-in-any-result');
  } finally {
    restore();
  }
});
