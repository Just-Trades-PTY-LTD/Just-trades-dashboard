import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';

// The lookup the Technician & Sales form's automatic prefill runs
// (GET /api/aroflo/lookup?activity=1): read-only against AroFlo (GET only),
// never writes to the CRM, a fixed small number of AroFlo requests, and
// invoice/visit dates in Adelaide time.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'reviews', 'audit_log', 'technicians', 'users', 'technician_accounts'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));

test('the prefill lookup only reads from AroFlo, writes nothing to the CRM, uses 7 requests, and gives Adelaide dates', async () => {
  const server = await startTestServer();
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    requests.push({ method: init?.method || 'GET', path: u.pathname });
    if (u.pathname === '/v2/businessunits') return json(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks') return json(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 2600 }] : [] });
    if (u.pathname === '/v2/tasks/T1') return json(200, { id: 'T1', jobNumber: 2600, status: 'PENDING', taskType: { name: 'Hot Water' }, client: { id: 'C1' }, locationText: '' });
    // 20:30 UTC on 3 Nov is 7:00am on 4 Nov in Adelaide.
    if (u.pathname === '/v2/invoices') return json(200, { items: [{ invoiceNumber: '9001', invoicedDateTime: '2026-11-03T20:30:00Z', totalAmountEx: 1234.5, totalAmount: 1357.95, status: 'APPROVED' }] });
    if (u.pathname === '/v2/customfields/CLIENTS/C1') return json(200, { items: [] });
    if (u.pathname === '/v2/tasks/T1/labours') return json(200, { items: [] });
    if (u.pathname === '/v2/schedules') return json(200, { items: [{ startTime: '2026-11-09T22:00:00.000Z', endTime: '2026-11-10T02:00:00.000Z', hours: 4, resource: { givenName: 'Ryan', familyName: 'Smith' } }] });
    return json(404, {});
  };
  try {
    await server.login();
    const before = dump();
    const res = await server.request('GET', '/aroflo/lookup?jn=2600&activity=1');
    assert.equal(res.status, 200);
    assert.equal(res.data.found, true);
    assert.deepEqual(res.data.invoices, [{ invoiceNumber: '9001', invoiceDate: '2026-11-04', saleValueExGst: 1234.5, status: 'APPROVED', type: '', alreadyRecorded: null }], 'the invoice\'s own totalAmountEx, Adelaide date');
    assert.deepEqual(res.data.activity.visits.map((v) => [v.date, v.start]), [['2026-11-10', '08:30']], 'visit in Adelaide time');
    assert.equal(requests.length, 7, `AroFlo requests: ${requests.map((r) => r.path).join(', ')}`);
    assert.ok(requests.every((r) => r.method === 'GET'), 'GET only — nothing is ever written to AroFlo');
    assert.deepEqual(dump(), before, 'nothing written to the CRM');
    // AroFlo unreachable: a clear message, not an error, and still nothing written.
    global.fetch = async (url, init) => (new URL(url).origin === 'http://mock.test' ? Promise.reject(new Error('down')) : original(url, init));
    const down = await server.request('GET', '/aroflo/lookup?jn=2600&activity=1');
    assert.equal(down.status, 200);
    assert.equal(down.data.found, false);
    assert.match(down.data.message, /could not be reached/);
    assert.deepEqual(dump(), before);
  } finally {
    global.fetch = original;
    server.close();
  }
});
