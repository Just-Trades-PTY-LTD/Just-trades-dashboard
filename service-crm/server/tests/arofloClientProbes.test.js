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

const { listTaskTypes, listLocations, listAroFloUsers, listScheduleZones, probeTaskHistory, probeLocationDetail } = await import(
  '../src/aroflo/client.js'
);

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
    assert.equal(results.length, 10, 'tries every candidate, including all four scheduleZone follow-ups');
    const tried = results.map((r) => r.tried);
    assert.deepEqual(tried, [
      '/tasks/TASK-1/timesheets',
      '/timesheets',
      '/tasks/TASK-1/schedules',
      '/schedules',
      "/schedules (scheduleZone='TASK')",
      "/schedules (scheduleZone='TASK', zoneId=businessUnitId)",
      "/schedules (scheduleZone='USER')",
      "/schedules (scheduleZone='USER', currentDate='" + new Date().toISOString().slice(0, 10) + "')",
      '/tasks/TASK-1/history',
      '/tasks/TASK-1/activity',
    ]);
    const timesheetsByQuery = results.find((r) => r.tried === '/timesheets');
    assert.equal(timesheetsByQuery.available, true);
    assert.deepEqual(timesheetsByQuery.data, { items: [{ userId: 'U1', hours: 4 }] });
    results
      .filter((r) => r.tried !== '/timesheets')
      .forEach((r) => assert.equal(r.available, false, `${r.tried} should be unavailable`));
    assert.equal(seen.length, 10, 'ran sequentially, not fanned out in parallel beyond the ten candidates');
  } finally {
    restore();
  }
});

test('probeTaskHistory\'s scheduleZone follow-ups send the confirmed enum values plus zoneId/currentDate, alongside the existing taskId', async () => {
  const seenQueries = [];
  const restore = stubFetch(async (url) => {
    if (url.pathname === '/v2/schedules') {
      seenQueries.push({
        scheduleZone: url.searchParams.get('scheduleZone'),
        taskId: url.searchParams.get('taskId'),
        zoneId: url.searchParams.get('zoneId'),
        currentDate: url.searchParams.get('currentDate'),
      });
    }
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    await probeTaskHistory('BU-1', 'TASK-1');
    assert.deepEqual(seenQueries, [
      { scheduleZone: null, taskId: 'TASK-1', zoneId: null, currentDate: null },
      { scheduleZone: 'TASK', taskId: 'TASK-1', zoneId: null, currentDate: null },
      { scheduleZone: 'TASK', taskId: 'TASK-1', zoneId: 'BU-1', currentDate: null },
      { scheduleZone: 'USER', taskId: 'TASK-1', zoneId: null, currentDate: null },
      { scheduleZone: 'USER', taskId: 'TASK-1', zoneId: null, currentDate: new Date().toISOString().slice(0, 10) },
    ]);
  } finally {
    restore();
  }
});

test('listScheduleZones tries each candidate zones endpoint and reports every result', async () => {
  const restore = stubFetch(async (url) => {
    if (url.pathname.endsWith('/zones')) return jsonResponse(200, { items: [{ id: 'Z1', name: 'Metro' }] });
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    const results = await listScheduleZones('BU-1');
    assert.deepEqual(
      results.map((r) => r.tried),
      ['/schedulezones', '/schedule-zones', '/zones']
    );
    assert.equal(results[0].available, false);
    assert.equal(results[2].available, true);
    assert.deepEqual(results[2].data, { items: [{ id: 'Z1', name: 'Metro' }] });
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

test('a non-404 error (e.g. a 400) surfaces AroFlo\'s own response body as `detail`, for diagnosing a wrong request shape', async () => {
  const restore = stubFetch(async () => jsonResponse(400, { error: 'Missing required field: fromDate' }));
  try {
    const result = await listTaskTypes('BU-1');
    assert.equal(result.available, false);
    assert.equal(result.status, 400);
    assert.deepEqual(result.detail, { error: 'Missing required field: fromDate' });
  } finally {
    restore();
  }
});

test('a 404 carries no detail body — nothing further to show once an endpoint simply doesn\'t exist', async () => {
  const restore = stubFetch(async () => jsonResponse(404, { error: 'not found' }));
  try {
    const result = await listTaskTypes('BU-1');
    assert.equal(result.status, 404);
    assert.deepEqual(result.detail, { error: 'not found' }, 'the body is still captured...');
    // ...the test page itself is what chooses not to render it for a 404 —
    // see ArofloTest.jsx's `r.status !== 404 && r.detail` condition.
  } finally {
    restore();
  }
});

test('the token is redacted even if AroFlo\'s own error body happens to echo part of the request back', async () => {
  const restore = stubFetch(async () =>
    jsonResponse(400, { error: 'Invalid Authorization header: Bearer test-token-should-never-appear-in-any-result' })
  );
  try {
    const result = await listTaskTypes('BU-1');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('test-token-should-never-appear-in-any-result'), 'token must never appear, even inside AroFlo\'s own echoed error');
    assert.ok(serialized.includes('[REDACTED]'), 'the rest of AroFlo\'s message is still shown, just with the token blanked out');
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
