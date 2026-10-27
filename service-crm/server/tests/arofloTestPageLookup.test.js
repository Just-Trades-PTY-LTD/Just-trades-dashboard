import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';

// Full-stack test of the admin-only AroFlo test page lookup (GET
// /api/aroflo-test/lookup) against a stubbed AroFlo. AROFLO_PAT must be set
// before config.js is first loaded, hence the dynamic import.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';

const { startTestServer } = await import('./helpers.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

function stubAroFloFetch(handler) {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'http://mock.test') {
      requests.push({ method: init?.method || 'GET', path: u.pathname });
      return handler(u, init);
    }
    return original(url, init);
  };
  return {
    requests,
    restore: () => {
      global.fetch = original;
    },
  };
}

const TASK = {
  id: 'T2572',
  jobNumber: 2572,
  status: 'COMPLETED',
  locationText: '14 Example Road Woodcroft SA 5162 AUSTRALIA',
  location: null,
  client: { id: 'C1' },
  schedule: null,
};

const COUNTED_TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'audit_log'];
const rowCounts = () => Object.fromEntries(COUNTED_TABLES.map((t) => [t, dbAll(`SELECT COUNT(*) AS n FROM ${t}`)[0].n]));

test('test page lookup: attendance probes, suburb comparison, no rates, no writes anywhere', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFloFetch(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: TASK.id, jobNumber: 2572 }] : [] });
      if (u.pathname === '/v2/tasks/T2572') return jsonResponse(200, TASK);
      if (u.pathname === '/v2/invoices') return jsonResponse(200, { items: [] });
      if (u.pathname === '/v2/tasks/T2572/labours') {
        return jsonResponse(200, {
          items: [{ id: 'L1', date: '2026-10-20', hours: 2.5, costRate: 55, sellRate: 120, user: { id: 'U1', givenName: 'Ryan', familyName: 'Smith' } }],
        });
      }
      if (u.pathname === '/v2/schedules') return jsonResponse(200, { items: [] });
      if (u.pathname === '/v2/tasks/T2572/resources') return jsonResponse(200, { items: [{ id: 'R1', resource: { id: 'U1', givenName: 'Ryan', familyName: 'Smith' } }] });
      if (u.pathname === '/v2/clients/C1') return jsonResponse(200, { id: 'C1', address: { suburb: 'Woodcroft', postcode: '5162' } });
      return jsonResponse(404, { error: 'not found' });
    });
    const before = rowCounts();
    try {
      const res = await server.request('GET', '/aroflo-test/lookup?jn=2572');
      assert.equal(res.status, 200);
      assert.equal(res.data.found, true);

      const history = res.data.investigation.history;
      assert.deepEqual(
        history.map((r) => [r.tried, r.available]),
        [
          ['/tasks/{taskId}/labours', true],
          ["/schedules (scheduleZone='TASK', zoneId={taskId})", true],
          ['/tasks/{taskId}/resources', true],
        ],
      );
      assert.equal(history[0].data.items[0].user.givenName, 'Ryan');

      assert.deepEqual(res.data.investigation.suburbComparison, {
        matchedFromAddressText: 'Woodcroft (5162)',
        taskLocation: null,
        customerAddress: { suburb: 'Woodcroft', postcode: '5162' },
      });

      // Rates are stripped from the probe; the token never appears at all.
      assert.doesNotMatch(JSON.stringify(res.data.investigation), /costRate|sellRate|quoteRate/);
      assert.doesNotMatch(JSON.stringify(res.data), /test-token-should-never-appear-anywhere/);

      // Read-only both ways: only GETs to AroFlo, and no CRM rows added or removed.
      assert.ok(stub.requests.every((r) => r.method === 'GET'));
      assert.deepEqual(rowCounts(), before);
    } finally {
      stub.restore();
    }
  } finally {
    await server.close();
  }
});
