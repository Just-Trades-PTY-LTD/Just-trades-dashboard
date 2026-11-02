import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { analyzeClientHistory } from '../src/aroflo/customerHistory.js';

// Customer history investigation on the admin AroFlo Test page
// (GET /api/aroflo-test/customer-history): read-only GETs to AroFlo only,
// nothing stored, and an assessment that never claims "repeat" or "new"
// unless the history is complete and unambiguous.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
function stubAroFlo(handler) {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'http://mock.test') {
      requests.push({ method: init?.method || 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams) });
      return handler(u);
    }
    return original(url, init);
  };
  return { requests, restore: () => (global.fetch = original) };
}

const task = (id, jobNumber, status, extra = {}) => ({
  id, jobNumber, status, client: { id: 'C1', name: 'Jane Citizen' }, location: { id: 'L1', suburb: 'Woodcroft', sitePhone: '0400 000 000' },
  taskType: { name: 'Hot Water' }, timestampCreated: `2026-0${Math.min(9, Math.floor(jobNumber / 1000))}-01T00:00:00Z`,
  completionDate: status === 'COMPLETED' || status === 'ARCHIVED' ? '2026-01-02T00:00:00Z' : null, ...extra,
});
const probe = (items, count = items.length) => ({ available: true, data: { count, items } });
const CURRENT = task('T3', 3000, 'PENDING');
const INDIVIDUAL = { available: true, data: { id: 'C1', name: 'Jane Citizen', individual: true } };
const base = (over = {}) => ({
  currentTask: CURRENT,
  clientDetail: INDIVIDUAL,
  probes: { defaultList: probe([task('T1', 1000, 'COMPLETED'), CURRENT]), archivedList: probe([]), locations: probe([{ id: 'L1' }]) },
  ...over,
});

test('repeat: an earlier completed job for the same individual at one site, complete history', () => {
  const a = analyzeClientHistory(base());
  assert.equal(a.assessment, 'repeat');
  assert.equal(a.filterHonoured, true);
  assert.deepEqual(a.earlierJobs.map((t) => t.jobNumber), [1000]);
  assert.equal(a.earlierCompletedCount, 1);
  assert.equal(a.clientId, 'C1');
  assert.ok(!JSON.stringify(a).includes('0400 000 000'), 'site phone numbers are never passed on');
});

test('new: only the current job, complete history', () => {
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT]), archivedList: probe([]), locations: probe([{ id: 'L1' }]) } }));
  assert.equal(a.assessment, 'new');
  assert.equal(a.earlierJobs.length, 0);
});

test('the current job and later jobs are never counted as earlier', () => {
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT, task('T4', 4000, 'COMPLETED')]), archivedList: probe([]), locations: probe([]) } }));
  assert.equal(a.earlierJobs.length, 0);
  assert.deepEqual(a.laterJobs.map((t) => t.jobNumber), [4000]);
  assert.equal(a.assessment, 'new');
});

test('archived earlier jobs are found through the archived-only list and reported if left out by default', () => {
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT]), archivedList: probe([task('T1', 1000, 'ARCHIVED')]), locations: probe([]) } }));
  assert.equal(a.archivedIncludedByDefault, false);
  assert.equal(a.assessment, 'repeat');
});

test('uncertain, never guessed: ignored filter, truncated list, organisation, several sites, parent, only uncompleted earlier jobs, refused list', () => {
  const cases = [
    [{ probes: { defaultList: probe([CURRENT, { ...task('X', 900, 'COMPLETED'), client: { id: 'OTHER' } }]), archivedList: probe([]), locations: probe([]) } }, /other customers/],
    [{ probes: { defaultList: probe([task('T1', 1000, 'COMPLETED'), CURRENT], 250), archivedList: probe([]), locations: probe([]) } }, /more than 100 jobs/],
    [{ clientDetail: { available: true, data: { id: 'C1', individual: false } } }, /organisation/],
    [{ probes: { defaultList: probe([task('T1', 1000, 'COMPLETED', { location: { id: 'L2' } }), CURRENT]), archivedList: probe([]), locations: probe([{ id: 'L1' }, { id: 'L2' }]) } }, /sites\/locations/],
    [{ clientDetail: { available: true, data: { id: 'C1', individual: true, parent: { id: 'P1', name: 'Agency' } } } }, /parent customer/],
    [{ probes: { defaultList: probe([task('T1', 1000, 'PENDING'), CURRENT]), archivedList: probe([]), locations: probe([]) } }, /none was completed/],
    [{ probes: { defaultList: { available: false, status: 400 }, archivedList: probe([]), locations: probe([]) } }, /refused/],
    [{ currentTask: { ...CURRENT, client: null } }, /no customer/],
  ];
  for (const [over, re] of cases) {
    const a = analyzeClientHistory(base(over));
    assert.equal(a.assessment, 'uncertain', String(re));
    assert.match(a.reasons.join(' '), re);
  }
});

test('route: admin only, GET-only to AroFlo, counts requests, reads and writes nothing in the CRM', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = stubAroFlo(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks' && u.searchParams.get('clientId') === 'C1') {
        const items = u.searchParams.get('status') === '4' ? [task('T1', 1000, 'ARCHIVED')] : [CURRENT];
        return jsonResponse(200, { count: items.length, items });
      }
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T3', jobNumber: 3000 }] : [] });
      if (u.pathname === '/v2/tasks/T3') return jsonResponse(200, CURRENT);
      if (u.pathname === '/v2/clients/C1') return jsonResponse(200, { id: 'C1', name: 'Jane Citizen', individual: true });
      if (u.pathname === '/v2/locations') return jsonResponse(200, { count: 1, items: [{ id: 'L1' }] });
      return jsonResponse(404, {});
    });
    const tables = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log', 'list_items'];
    const before = Object.fromEntries(tables.map((t) => [t, dbAll(`SELECT * FROM ${t}`)]));
    try {
      const res = await server.request('GET', '/aroflo-test/customer-history?jn=3000');
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.analysis.assessment, 'repeat');
      assert.equal(res.data.analysis.archivedIncludedByDefault, false);
      assert.equal(res.data.historyCalls, 3, 'customer-history part: 3 AroFlo requests');
      assert.equal(res.data.totalCalls, stub.requests.length);
      assert.ok(stub.requests.every((r) => r.method === 'GET'), 'GET only');
      const clientCalls = stub.requests.filter((r) => r.params.clientId === 'C1');
      assert.ok(clientCalls.every((r) => r.params.clientId === 'C1'));
      assert.ok(!JSON.stringify(res.data).includes('test-token'), 'token never exposed');
      assert.deepEqual(Object.fromEntries(tables.map((t) => [t, dbAll(`SELECT * FROM ${t}`)])), before, 'nothing stored or changed in the CRM');
    } finally {
      stub.restore();
    }
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-ch@test.local', password: 'password123', role: 'staff' }));
    await server.login('staff-ch@test.local', 'password123');
    assert.equal((await server.request('GET', '/aroflo-test/customer-history?jn=3000')).status, 403);
  } finally {
    server.close();
  }
});

function ok(res) {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
}
