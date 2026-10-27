import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';

// Full-stack tests of the live AroFlo lookup's read-only activity and
// draft-invoice flag (GET /api/aroflo/lookup) against a stubbed AroFlo.
// AROFLO_PAT must be set before config.js is first loaded, hence the
// dynamic import.
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

const TASK = { id: 'T2432', jobNumber: 2432, status: 'PENDING', locationText: '40 Example Parade Blackwood SA 5051 AUSTRALIA', client: null };
const RYAN = { id: 'U2', givenName: 'Ryan S', familyName: 'El Install', position: 'Electrician - Installer', email: 'ryans@example.test', mobile: '0421 000 000' };

function arofloHandler({ laboursStatus = 200, schedulesStatus = 200 } = {}) {
  return async (u) => {
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: TASK.id, jobNumber: 2432 }] : [] });
    if (u.pathname === '/v2/tasks/T2432') return jsonResponse(200, TASK);
    if (u.pathname === '/v2/invoices') {
      return jsonResponse(200, {
        items: [
          { invoiceNumber: 'INV-1', invoicedDateTime: '2026-10-08T00:00:00', totalAmountEx: 450, status: 'Pending Approval' },
          { invoiceNumber: 'INV-2', invoicedDateTime: '2026-10-09T00:00:00', totalAmountEx: 900, status: 'Processed' },
        ],
      });
    }
    if (u.pathname === '/v2/tasks/T2432/labours') {
      if (laboursStatus !== 200) return jsonResponse(laboursStatus, { error: 'Forbidden' });
      return jsonResponse(200, {
        items: [{ date: '2026-10-07', startTime: '2026-10-07T09:05:00', finishTime: '2026-10-07T11:24:00', hours: '2.32', sellRate: 120, user: { ...RYAN, givenName: 'Cody W', familyName: 'El Service' } }],
      });
    }
    if (u.pathname === '/v2/schedules') {
      if (schedulesStatus !== 200) return jsonResponse(schedulesStatus, { error: 'Forbidden' });
      return jsonResponse(200, { items: [{ startTime: '2026-10-27T20:30:00.000Z', endTime: '2026-10-28T05:30:00.000Z', hours: 9, resource: RYAN }] });
    }
    return jsonResponse(404, { error: 'not found' });
  };
}

const COUNTED_TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'audit_log'];
const rowCounts = () => Object.fromEntries(COUNTED_TABLES.map((t) => [t, dbAll(`SELECT COUNT(*) AS n FROM ${t}`)[0].n]));

test('with activity=1: labour and booked visits in Adelaide time, drafts flagged, no contact details, no writes', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFloFetch(arofloHandler());
    const before = rowCounts();
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2432&activity=1');
      assert.equal(res.status, 200);
      assert.equal(res.data.found, true);
      assert.deepEqual(res.data.activity, {
        labour: [{ technician: 'Cody W El Service', position: 'Electrician - Installer', date: '2026-10-07', start: '09:05', finish: '11:24', hours: 2.32 }],
        visits: [{ technician: 'Ryan S El Install', position: 'Electrician - Installer', date: '2026-10-28', start: '07:00', finish: '16:00', hours: 9 }],
      });
      assert.deepEqual(
        res.data.invoices.map((i) => [i.invoiceNumber, i.isDraft]),
        [
          ['INV-1', true],
          ['INV-2', false],
        ],
      );
      assert.doesNotMatch(JSON.stringify(res.data), /example\.test|0421|sellRate|test-token/);
      assert.ok(stub.requests.every((r) => r.method === 'GET'));
      assert.deepEqual(rowCounts(), before);
    } finally {
      stub.restore();
    }
  } finally {
    await server.close();
  }
});

test('without activity=1 (the Lead Source lookup): no extra AroFlo calls and no activity', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFloFetch(arofloHandler());
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2432');
      assert.equal(res.data.found, true);
      assert.equal(res.data.activity, undefined);
      assert.ok(!stub.requests.some((r) => r.path.endsWith('/labours') || r.path === '/v2/schedules'));
    } finally {
      stub.restore();
    }
  } finally {
    await server.close();
  }
});

test("AroFlo refusing labour or schedules never breaks the lookup — that part is just shown as unavailable", async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFloFetch(arofloHandler({ laboursStatus: 403, schedulesStatus: 500 }));
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2432&activity=1');
      assert.equal(res.status, 200);
      assert.equal(res.data.found, true);
      assert.deepEqual(res.data.activity, { labour: null, visits: null });
      assert.equal(res.data.invoices.length, 2);
    } finally {
      stub.restore();
    }
  } finally {
    await server.close();
  }
});
