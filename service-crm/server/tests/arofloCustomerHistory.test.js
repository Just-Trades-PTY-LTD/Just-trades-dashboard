import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { analyzeClientHistory, jobOutcome, summarizeCustomFields, maskContactDetails } from '../src/aroflo/customerHistory.js';

// Customer history investigation on the admin AroFlo Test page
// (GET /api/aroflo-test/customer-history): read-only GETs to AroFlo only,
// nothing stored, privacy-safe output, and an assessment that never claims
// "repeat" unless the history is complete and unambiguous — and never claims
// "new" at all.
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
      requests.push({ method: init?.method || 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams), body: init?.body });
      return handler(u);
    }
    return original(url, init);
  };
  return { requests, restore: () => (global.fetch = original) };
}

// Planted contact details: none of these may ever reach the response.
const PHONE = '0412 345 678';
const EMAIL = 'jane.citizen@example.com';
const STREET = '14 Example Road';
const task = (id, jobNumber, status, extra = {}) => ({
  id, jobNumber, status, client: { id: 'C1', name: 'Jane Citizen' },
  location: { id: 'L1', suburb: 'Woodcroft', address1: STREET, sitePhone: PHONE, siteContact: EMAIL },
  locationText: `${STREET} Woodcroft SA 5162 AUSTRALIA`,
  taskType: { name: 'Hot Water' }, timestampCreated: `2026-0${Math.min(9, Math.floor(jobNumber / 1000))}-01T00:00:00Z`,
  completionDate: status === 'COMPLETED' ? '2026-01-02T00:00:00Z' : null, ...extra,
});
const probe = (items, count = items.length, extra = {}) => ({ available: true, data: { count, items }, pagesFetched: 1, truncated: false, ...extra });
const CURRENT = task('T3', 3000, 'PENDING');
const INDIVIDUAL = { available: true, data: { id: 'C1', name: 'Jane Citizen', individual: true } };
const base = (over = {}) => ({
  currentTask: CURRENT,
  clientDetail: INDIVIDUAL,
  probes: { defaultList: probe([task('T1', 1000, 'COMPLETED'), CURRENT]), archivedList: probe([]), siteList: probe([task('T1', 1000, 'COMPLETED'), CURRENT]), locations: probe([{ id: 'L1' }]) },
  sameNameClients: probe([{ id: 'C1' }]),
  ...over,
});

test('repeat: an earlier completed job for the same individual at one site, filters proven, complete history', () => {
  const a = analyzeClientHistory(base());
  assert.equal(a.assessment, 'repeat');
  assert.equal(a.customerFilterHonoured, true);
  assert.equal(a.siteFilterHonoured, true);
  assert.deepEqual(a.earlierJobs.map((t) => t.jobNumber), [1000]);
  assert.equal(a.earlierCompletedCount, 1);
  assert.equal(a.earlierCompletedAtThisSite, 1);
});

test('never "new": with no earlier completed job it only says none was found', () => {
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT]), archivedList: probe([]), siteList: probe([CURRENT]), locations: probe([{ id: 'L1' }]) } }));
  assert.equal(a.assessment, 'no-earlier-completed-job');
  assert.match(a.assessmentLabel, /does not prove the customer is new/);
  assert.ok(!/"new"|assessment":"new/.test(JSON.stringify(a)));
});

test('earlier quotes, cancellations and unfinished or archived-without-completion jobs are not completed work', () => {
  assert.equal(jobOutcome({ status: 'COMPLETED', completed: '2026-01-01' }), 'completed');
  assert.equal(jobOutcome({ status: 'ARCHIVED', completed: '2026-01-01' }), 'completed');
  assert.equal(jobOutcome({ status: 'ARCHIVED', completed: null }), 'archived (no completion date)');
  assert.equal(jobOutcome({ status: 'ARCHIVED', substatus: 'Cancelled', completed: '2026-01-01' }), 'cancelled');
  assert.equal(jobOutcome({ status: 'PENDING', taskType: 'Quote - Solar' }), 'quote');
  assert.equal(jobOutcome({ status: 'IN_PROGRESS' }), 'unfinished');
  const earlier = [
    task('Q', 1000, 'COMPLETED', { substatus: { name: 'Quote declined' } }),
    task('C', 1100, 'ARCHIVED', { substatus: { name: 'Cancelled' } }),
    task('A', 1200, 'ARCHIVED'),
    task('P', 1300, 'IN_PROGRESS'),
  ];
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([...earlier, CURRENT]), archivedList: probe([]), siteList: probe([...earlier, CURRENT]), locations: probe([{ id: 'L1' }]) } }));
  assert.equal(a.earlierCompletedCount, 0);
  assert.equal(a.assessment, 'no-earlier-completed-job');
  assert.deepEqual(a.earlierJobs.map((t) => t.outcome), ['quote', 'cancelled', 'archived (no completion date)', 'unfinished']);
});

test('archived history: found through the archived-only list and reported if left out by default', () => {
  const archived = task('T1', 1000, 'ARCHIVED', { completionDate: '2025-05-01T00:00:00Z' });
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT]), archivedList: probe([archived]), siteList: probe([CURRENT]), locations: probe([{ id: 'L1' }]) } }));
  assert.equal(a.archivedIncludedByDefault, false);
  assert.equal(a.assessment, 'repeat');
});

test('the current job and later jobs are never counted as earlier', () => {
  const a = analyzeClientHistory(base({ probes: { defaultList: probe([CURRENT, task('T4', 4000, 'COMPLETED')]), archivedList: probe([]), siteList: probe([CURRENT]), locations: probe([{ id: 'L1' }]) } }));
  assert.equal(a.earlierJobs.length, 0);
  assert.deepEqual(a.laterJobs.map((t) => t.jobNumber), [4000]);
});

test('uncertain, never guessed', () => {
  const cases = [
    ['customer filter ignored', { probes: { ...base().probes, defaultList: probe([CURRENT, task('X', 900, 'COMPLETED', { client: { id: 'OTHER' } })]) } }, /different customer — the customer filter was not applied/],
    ['site filter ignored', { probes: { ...base().probes, siteList: probe([CURRENT, task('X', 900, 'COMPLETED', { location: { id: 'L9' } })]) } }, /different site — the site filter was not applied/],
    ['current job missing from list', { probes: { ...base().probes, defaultList: probe([task('T1', 1000, 'COMPLETED')]) } }, /current job itself wasn't in the customer's job list/],
    ['over the page limit', { probes: { ...base().probes, defaultList: probe([task('T1', 1000, 'COMPLETED'), CURRENT], 750, { truncated: true, pagesFetched: 5 }) } }, /history is incomplete/],
    ['organisation', { clientDetail: { available: true, data: { id: 'C1', individual: false } } }, /organisation/],
    ['individual flag unknown', { clientDetail: { available: true, data: { id: 'C1' } } }, /individual or an organisation/],
    ['parent account', { clientDetail: { available: true, data: { id: 'C1', individual: true, parent: { id: 'P1', name: 'Agency' } } } }, /parent customer/],
    ['several sites', { probes: { ...base().probes, locations: probe([{ id: 'L1' }, { id: 'L2' }]) } }, /2 sites\/properties/],
    ['same-name duplicate record', { sameNameClients: probe([{ id: 'C1' }, { id: 'C7' }]) }, /1 other AroFlo customer record/],
    ['no site, several or no site records', { currentTask: { ...CURRENT, location: null }, probes: { ...base().probes, siteList: null, locations: probe([]) } }, /can't be confirmed earlier jobs were at the same property/],
    ['customer list refused', { probes: { ...base().probes, defaultList: { available: false, status: 400 } } }, /refused/],
    ['archived list refused', { probes: { ...base().probes, archivedList: { available: false, status: 400 } } }, /Archived jobs couldn't be checked/],
    ['no customer', { currentTask: { ...CURRENT, client: null } }, /no customer/],
  ];
  for (const [name, over, re] of cases) {
    const a = analyzeClientHistory(base(over));
    assert.equal(a.assessment, 'uncertain', name);
    assert.match(a.reasons.join(' '), re, name);
  }
  // A job with no linked site is fine when the customer has exactly one site.
  const oneSite = analyzeClientHistory(base({ currentTask: { ...CURRENT, location: null }, probes: { ...base().probes, siteList: null, locations: probe([{ id: 'L1' }]) } }));
  assert.equal(oneSite.assessment, 'repeat');
});

test('custom fields: Lead Source found at any level; email addresses and phone numbers masked', () => {
  const z = summarizeCustomFields({ available: true, data: { items: [{ customField: { name: 'Lead Source', value: 'Google' } }, { customField: { name: 'Occupant', value: `Tenant ${EMAIL} ${PHONE}` } }] } }, 'CLIENTS');
  assert.equal(z.leadSource, 'Google');
  assert.equal(z.fields[1].value, 'Tenant [email hidden] [phone hidden]');
  assert.equal(maskContactDetails('+61 412 345 678'), '[phone hidden]');
  assert.deepEqual(summarizeCustomFields({ available: false, status: 404 }, 'LOCATIONS'), { zone: 'LOCATIONS', available: false, status: 404, fields: [] });
});

// A stubbed AroFlo: 101-130 jobs for the customer (two pages), one archived
// earlier job, a linked site, a same-name check and custom fields at all levels.
function arofloStub({ manyJobs = false } = {}) {
  const customerJobs = manyJobs ? [...Array.from({ length: 129 }, (_, i) => task(`H${i}`, 100 + i, 'COMPLETED')), CURRENT] : [CURRENT];
  return stubAroFlo(async (u) => {
    const p = u.searchParams;
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks' && (p.get('clientId') === 'C1' || p.get('locationId') === 'L1')) {
      const all = p.get('status') === '4' ? [task('T1', 1000, 'ARCHIVED', { completionDate: '2025-05-01T00:00:00Z' })] : customerJobs;
      const page = Number(p.get('page'));
      return jsonResponse(200, { count: all.length, items: all.slice((page - 1) * 100, page * 100) });
    }
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: p.get('page') === '1' ? [{ id: 'T3', jobNumber: 3000 }] : [] });
    if (u.pathname === '/v2/tasks/T3') return jsonResponse(200, CURRENT);
    if (u.pathname === '/v2/clients/C1') return jsonResponse(200, { id: 'C1', name: 'Jane Citizen', individual: true, phone: PHONE, email: EMAIL, address: { addressLine1: STREET } });
    if (u.pathname === '/v2/clients') return jsonResponse(200, { items: [{ id: 'C1' }] });
    if (u.pathname === '/v2/locations') return jsonResponse(200, { count: 1, items: [{ id: 'L1', address1: STREET, sitePhone: PHONE }] });
    if (u.pathname === '/v2/customfields/CLIENTS/C1') return jsonResponse(200, { items: [{ customField: { name: 'Lead Source', value: 'Google' } }, { customField: { name: 'Contact', value: EMAIL } }] });
    if (u.pathname === '/v2/customfields/TASKS/T3') return jsonResponse(200, { items: [] });
    if (u.pathname === '/v2/customfields/LOCATIONS/L1') return jsonResponse(200, { items: [{ customField: { name: 'Gate code', value: '1234' } }] });
    return jsonResponse(404, {});
  });
}

const CRM_TABLES = ['users', 'calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log', 'list_items', 'app_settings', 'technicians', 'suburbs'];
const crmSnapshot = () => Object.fromEntries(CRM_TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t}`)]));

test('route: GET-only, filters sent and verified, archived and site history, request count and time, privacy-safe, nothing written', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const before = crmSnapshot();
    const stub = arofloStub();
    try {
      const res = await server.request('GET', '/aroflo-test/customer-history?jn=3000');
      assert.equal(res.status, 200, JSON.stringify(res.data));
      const d = res.data;
      assert.ok(stub.requests.every((r) => r.method === 'GET' && r.body === undefined), 'GET only, no request bodies');
      assert.equal(d.totalCalls, stub.requests.length, 'every AroFlo request is counted');
      assert.ok(Number.isFinite(d.elapsedMs) && d.elapsedMs >= 0, 'time taken reported');
      // The filters really were sent…
      assert.ok(stub.requests.some((r) => r.params.clientId === 'C1' && !r.params.status));
      assert.ok(stub.requests.some((r) => r.params.clientId === 'C1' && r.params.status === '4'));
      assert.ok(stub.requests.some((r) => r.params.locationId === 'L1'));
      assert.ok(stub.requests.some((r) => r.path === '/v2/customfields/LOCATIONS/L1'), 'site-level custom fields checked');
      // …and verified from the answers.
      assert.equal(d.analysis.customerFilterHonoured, true);
      assert.equal(d.analysis.siteFilterHonoured, true);
      assert.equal(d.analysis.archivedIncludedByDefault, false);
      assert.equal(d.analysis.assessment, 'repeat', 'the archived completed job 1000 is earlier');
      assert.deepEqual(d.customFields.map((z) => [z.zone, z.leadSource]), [['TASKS (this job)', null], ['CLIENTS (the customer)', 'Google'], ['LOCATIONS (the site)', null]]);
      // Privacy: no phone, email or street address anywhere in the response.
      const json = JSON.stringify(d);
      for (const secret of [PHONE, EMAIL, STREET, 'test-token']) assert.ok(!json.includes(secret), `never exposed: ${secret}`);
      assert.deepEqual(crmSnapshot(), before, 'nothing stored or changed in the CRM');
    } finally {
      stub.restore();
    }
  } finally {
    server.close();
  }
});

test('route: histories over 100 jobs are paged and reported; admin only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = arofloStub({ manyJobs: true });
    try {
      const d = (await server.request('GET', '/aroflo-test/customer-history?jn=3000')).data;
      assert.equal(d.analysis.totals.customerJobs, 130);
      assert.equal(d.analysis.pagesRead.customer, 2, 'second page read');
      assert.equal(d.analysis.truncated, false, 'complete after paging');
      assert.equal(d.analysis.earlierCompletedCount, 130, '129 earlier + archived job 1000');
      const pages = stub.requests.filter((r) => r.path === '/v2/tasks' && r.params.clientId === 'C1' && !r.params.status).map((r) => r.params.page);
      assert.deepEqual(pages, ['1', '2']);
    } finally {
      stub.restore();
    }
    const res = await server.request('POST', '/users', { name: 'Staff', email: 'staff-ch@test.local', password: 'password123', role: 'staff' });
    assert.equal(res.status, 201);
    server.setCookie('');
    await server.login('staff-ch@test.local', 'password123');
    for (const path of ['/aroflo-test/customer-history?jn=3000', '/aroflo-test/suburb-check', '/aroflo-test/task-types-all']) {
      assert.equal((await server.request('GET', path)).status, 403, path);
    }
  } finally {
    server.close();
  }
});
