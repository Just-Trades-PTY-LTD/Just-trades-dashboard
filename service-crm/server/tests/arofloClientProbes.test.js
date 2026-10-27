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

const {
  listTaskTypes,
  listLocations,
  listAroFloUsers,
  probeTaskHistory,
  withoutRates,
  probeLocationDetail,
  probeCustomFields,
  probeClientDetail,
  getCustomFieldValue,
} = await import('../src/aroflo/client.js');

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
    assert.equal(url.pathname, '/v2/types/tasks');
    return jsonResponse(200, { items: [{ id: 1, name: 'Fans' }] });
  });
  try {
    const result = await listTaskTypes('BU-1');
    assert.equal(result.tried, '/types/tasks');
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

test('probeTaskHistory tries the three documented endpoints, in order, and reports each independently', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(url);
    if (url.pathname === '/v2/tasks/TASK-1/labours') return jsonResponse(200, { items: [{ id: 'L1', hours: 4 }] });
    if (url.pathname === '/v2/schedules') return jsonResponse(400, { error: 'Scheduling permission required' });
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    const results = await probeTaskHistory('BU-1', 'TASK-1');
    assert.deepEqual(
      results.map((r) => r.tried),
      ['/tasks/{taskId}/labours', "/schedules (scheduleZone='TASK', zoneId={taskId})", '/tasks/{taskId}/resources'],
    );
    assert.equal(results[0].available, true);
    assert.deepEqual(results[0].data, { items: [{ id: 'L1', hours: 4 }] });
    assert.equal(results[1].available, false);
    assert.equal(results[1].status, 400);
    assert.deepEqual(results[1].detail, { error: 'Scheduling permission required' });
    assert.equal(results[2].available, false);
    assert.equal(seen.length, 3, 'one request per endpoint, nothing else');
  } finally {
    restore();
  }
});

test("the schedules probe sends the task's own id as zoneId, never the business unit's", async () => {
  let query = null;
  const restore = stubFetch(async (url) => {
    if (url.pathname === '/v2/schedules') query = Object.fromEntries(url.searchParams);
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    await probeTaskHistory('BU-1', 'TASK-1');
    assert.deepEqual(query, { scheduleZone: 'TASK', zoneId: 'TASK-1', businessUnitId: 'BU-1' });
  } finally {
    restore();
  }
});

test('labour pay and charge rates never reach the result, at any depth', async () => {
  const restore = stubFetch(async (url) => {
    if (url.pathname === '/v2/tasks/TASK-1/labours') {
      return jsonResponse(200, {
        items: [
          {
            id: 'L1',
            hours: 4,
            costRate: 55,
            sellRate: 120,
            user: { id: 'U1', givenName: 'Ryan', familyName: 'Smith' },
            workType: { id: 'W1', name: 'Normal', sellRate: 120, quoteRate: 110 },
            overhead: { id: 'O1', costRate: 10, sellRate: 20 },
          },
        ],
      });
    }
    return jsonResponse(404, { error: 'not found' });
  });
  try {
    const [labours] = await probeTaskHistory('BU-1', 'TASK-1');
    assert.deepEqual(labours.data, {
      items: [
        {
          id: 'L1',
          hours: 4,
          user: { id: 'U1', givenName: 'Ryan', familyName: 'Smith' },
          workType: { id: 'W1', name: 'Normal' },
          overhead: { id: 'O1' },
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(labours), /Rate/);
  } finally {
    restore();
  }
});

test('withoutRates leaves everything else untouched, including null and non-object values', () => {
  assert.equal(withoutRates(null), null);
  assert.equal(withoutRates('x'), 'x');
  assert.deepEqual(withoutRates({ a: [1, { sellRate: 1, b: null }] }), { a: [1, { b: null }] });
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

test('probeClientDetail is a no-op (no request at all) when there is no client id', async () => {
  const restore = stubFetch(async () => {
    throw new Error('fetch should never be called when clientId is falsy');
  });
  try {
    const result = await probeClientDetail(null);
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('probeClientDetail fetches the given id when present', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url.pathname, '/v2/clients/CLI-1');
    return jsonResponse(200, { id: 'CLI-1', name: 'Luke Zhang', customFields: { 'Lead Source': 'Online Enquiry' } });
  });
  try {
    const result = await probeClientDetail('CLI-1');
    assert.equal(result.available, true);
    assert.deepEqual(result.data, { id: 'CLI-1', name: 'Luke Zhang', customFields: { 'Lead Source': 'Online Enquiry' } });
  } finally {
    restore();
  }
});

test('probeCustomFields uses the documented path-based endpoint for the TASKS zone', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url.pathname, '/v2/customfields/TASKS/TASK-1');
    assert.equal(url.search, '');
    // Real shape confirmed against a live account: each entry sits directly
    // under `items`, not nested under an `items[].fields[]` as the written
    // docs' schema implied.
    return jsonResponse(200, {
      count: 1,
      items: [{ id: 'K890006EXD0', customField: { name: 'Call Out', value: 'No Fee' } }],
    });
  });
  try {
    const results = await probeCustomFields('TASK-1', null);
    assert.equal(results.length, 1, 'no client id — only the TASKS zone is tried');
    assert.equal(results[0].tried, '/customfields/TASKS/{taskId}');
    assert.equal(results[0].available, true);
    assert.equal(results[0].data.items[0].customField.name, 'Call Out');
  } finally {
    restore();
  }
});

test('probeCustomFields also tries the CLIENTS zone when a client id is known', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(url.pathname);
    if (url.pathname === '/v2/customfields/TASKS/TASK-1') return jsonResponse(404, { error: 'not found' });
    if (url.pathname === '/v2/customfields/CLIENTS/CLI-1') {
      return jsonResponse(200, {
        count: 2,
        items: [
          { id: 'K89000229TR', customField: { name: 'Lead Source', value: 'Online Enquiry' } },
          { id: 'K89000229V0', customField: { name: 'Occupant', value: 'Homeowner' } },
        ],
      });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });
  try {
    const results = await probeCustomFields('TASK-1', 'CLI-1');
    assert.equal(results.length, 2);
    assert.deepEqual(seen, ['/v2/customfields/TASKS/TASK-1', '/v2/customfields/CLIENTS/CLI-1']);
    assert.equal(results[0].tried, '/customfields/TASKS/{taskId}');
    assert.equal(results[0].available, false);
    assert.equal(results[1].tried, '/customfields/CLIENTS/{clientId}');
    assert.equal(results[1].available, true);
    assert.equal(results[1].data.items[0].customField.name, 'Lead Source');
  } finally {
    restore();
  }
});

test('getCustomFieldValue returns null without a request when id is falsy', async () => {
  const restore = stubFetch(async () => {
    throw new Error('fetch should never be called when id is falsy');
  });
  try {
    assert.equal(await getCustomFieldValue('CLIENTS', null, 'Lead Source'), null);
  } finally {
    restore();
  }
});

test('getCustomFieldValue finds a named field (case-insensitively) among a client\'s custom fields', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url.pathname, '/v2/customfields/CLIENTS/CLI-1');
    return jsonResponse(200, {
      count: 2,
      items: [
        { id: 'K89000229TR', customField: { name: 'Lead Source', value: 'Online Enquiry' } },
        { id: 'K89000229V0', customField: { name: 'Occupant', value: 'Homeowner' } },
      ],
    });
  });
  try {
    assert.equal(await getCustomFieldValue('CLIENTS', 'CLI-1', 'lead source'), 'Online Enquiry');
  } finally {
    restore();
  }
});

test('getCustomFieldValue returns null when that field isn\'t present, and never throws on a 404', async () => {
  const restore = stubFetch(async () => jsonResponse(404, { error: 'not found' }));
  try {
    assert.equal(await getCustomFieldValue('CLIENTS', 'CLI-1', 'Lead Source'), null);
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
