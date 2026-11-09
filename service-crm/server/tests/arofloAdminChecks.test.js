import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';

// Admin AroFlo Test page: the real-address suburb check and the active +
// archived task-type list (read-only, admin-only, privacy-safe), and the
// forms' lookup returning the job address only when no suburb matched.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { addressSummary } = await import('../src/routes/arofloTest.js');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
function stubAroFlo(handler) {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'http://mock.test') {
      requests.push({ method: init?.method || 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams), body: init?.body });
      return handler(u);
    }
    return original(url, init);
  };
  return { requests, restore: () => (global.fetch = original) };
}

const ADDRESSES = {
  T1: '65 Tyne Avenue Kilburn SA 5084 AUSTRALIA',
  T2: '4 Beach Road North Brighton SA 5048',
  T3: '7 Smart Road Modbery North SA 5092 AUSTRALIA',
  T4: '1 George Street Sydney NSW 2000 AUSTRALIA',
  T5: '12 Smith Street Kilburn SA',
};
const CRM_TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'audit_log', 'app_settings', 'suburbs', 'list_items'];
const crmSnapshot = () => Object.fromEntries(CRM_TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t}`)]));

test('address summary never includes the house number or the full street', () => {
  assert.equal(addressSummary({ locationText: '65 Tyne Avenue Kilburn SA 5084 AUSTRALIA' }), '…Kilburn SA 5084');
  assert.equal(addressSummary({ locationText: 'Unit 3/12 Smith Street Woodville West SA 5011' }), '…Woodville West SA 5011');
  assert.equal(addressSummary({ locationText: '5 Kensington Road Kensington Park SA 5068' }), '…Kensington Park SA 5068');
  assert.equal(addressSummary({ locationText: 'Lot 4 Kilburn SA 5084' }), '…Kilburn SA 5084');
  assert.equal(addressSummary({ location: { suburb: 'Kilburn', state: 'SA', postCode: '5084', address1: '65 Tyne Avenue' } }), 'site record: Kilburn SA 5084');
  assert.equal(addressSummary({ locationText: '12 Smith Street Kilburn' }), '…Kilburn (no state + postcode found)');
  assert.equal(addressSummary({}), '(no address in AroFlo)');
});

test('suburb check: recent jobs, today vs proposed, outcome and reason — privacy-safe, GET-only, nothing written, admin only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const before = crmSnapshot();
    const stub = stubAroFlo(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: Object.keys(ADDRESSES).map((id, i) => ({ id, jobNumber: 5000 - i, location: null })) });
      const m = u.pathname.match(/^\/v2\/tasks\/(T\d)$/);
      if (m) return jsonResponse(200, { id: m[1], location: null, locationText: ADDRESSES[m[1]] });
      return jsonResponse(404, {});
    });
    try {
      const res = await server.request('GET', '/aroflo-test/suburb-check?count=5');
      assert.equal(res.status, 200, JSON.stringify(res.data));
      const byJn = Object.fromEntries(res.data.rows.map((r) => [r.jobNumber, r]));
      assert.deepEqual([byJn[5000].current, byJn[5000].proposed, byJn[5000].outcome, byJn[5000].change], ['Kilburn (5084)', 'Kilburn (5084)', 'matched', 'same']);
      assert.deepEqual([byJn[4999].current, byJn[4999].proposed, byJn[4999].change], [null, 'North Brighton (5048)', 'newly matched']);
      assert.deepEqual([byJn[4998].outcome, byJn[4998].proposed], ['uncertain', null]);
      assert.match(byJn[4998].reason, /misspelt/);
      assert.deepEqual([byJn[4997].outcome, byJn[4997].reason], ['rejected', 'the job address is outside South Australia']);
      assert.equal(byJn[4996].outcome, 'rejected');
      assert.deepEqual(res.data.tally, { matched: 2, uncertain: 1, rejected: 2 });
      assert.equal(res.data.totalCalls, 1 + 1 + 5);
      assert.ok(stub.requests.every((r) => r.method === 'GET' && r.body === undefined));
      assert.ok(stub.requests.filter((r) => /\/tasks\/T/.test(r.path)).every((r) => r.params._fields === 'id,jobNumber,location,locationText'), 'only address fields requested');
      const json = JSON.stringify(res.data);
      for (const street of ['Tyne', 'Beach Road', 'Smart Road', 'George Street', 'Smith Street']) assert.ok(!json.includes(street), `street never returned: ${street}`);
      assert.deepEqual(crmSnapshot(), before, 'nothing stored');
      assert.equal((await server.request('GET', '/aroflo-test/suburb-check?count=500')).status, 200);
      assert.equal(stub.requests.filter((r) => r.path === '/v2/tasks').at(-1).params.limit, '40', 'capped at 40 jobs');
    } finally {
      stub.restore();
    }
  } finally {
    server.close();
  }
});

test('task types: active and archived lists, every page, read-only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFlo(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/types/tasks') {
        const archived = u.searchParams.get('archived') === 'true';
        const page = Number(u.searchParams.get('page'));
        const all = archived ? [{ id: 'X1', name: 'Old Gas Check' }] : Array.from({ length: 120 }, (_, i) => ({ id: `A${i}`, name: `Type ${i}` }));
        return jsonResponse(200, { items: all.slice((page - 1) * 100, page * 100) });
      }
      return jsonResponse(404, {});
    });
    try {
      const d = (await server.request('GET', '/aroflo-test/task-types-all')).data;
      assert.equal(d.active.data.items.length, 120, 'both pages of active types');
      assert.deepEqual(d.archived.data.items.map((t) => t.name), ['Old Gas Check']);
      assert.ok(stub.requests.every((r) => r.method === 'GET'));
    } finally {
      stub.restore();
    }
  } finally {
    server.close();
  }
});

test('forms\' lookup: the job address is returned for reference only when no confident suburb was matched', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    let text = '7 Smart Road Modbery North SA 5092 AUSTRALIA';
    const stub = stubAroFlo(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T9', jobNumber: 9000 }] : [] });
      if (u.pathname === '/v2/tasks/T9') return jsonResponse(200, { id: 'T9', jobNumber: 9000, status: 'COMPLETED', locationText: text, location: null, client: { id: 'C1' } });
      if (u.pathname === '/v2/invoices') return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    try {
      let d = (await server.request('GET', '/aroflo/lookup?jn=9000')).data;
      assert.equal(d.suburb, null);
      assert.equal(d.addressForReference, '…Modbery North SA 5092', 'privacy-safe: no house number or street');
      text = '7 Smart Road Modbury North SA 5092 AUSTRALIA';
      d = (await server.request('GET', '/aroflo/lookup?jn=9000')).data;
      assert.equal(d.suburb, 'Modbury North (5092)', 'today this overlap was left blank');
      assert.equal(d.addressForReference, null, 'no address sent when a suburb matched');
    } finally {
      stub.restore();
    }
  } finally {
    server.close();
  }
});
