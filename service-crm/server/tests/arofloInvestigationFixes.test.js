import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { analyzeClientHistory, compareAddresses, normalizeAddress, summarizeCustomFields, ADDRESS_SAME, ADDRESS_DIFFERENT, ADDRESS_UNABLE } from '../src/aroflo/customerHistory.js';
import { callLookupSummary } from '../../client/src/lib/arofloCallSuggest.js';

// Admin investigation fixes and the call-form Lead Source fix: privacy-safe
// same-address comparison, Occupant flag, both Lead Source field names, the
// duplicate-customer check (with a clean AroFlo status when refused), the
// read-only Lead Source options tool, and the Valley View summary fix.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { suburbCheckRow } = await import('../src/routes/arofloTest.js');

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

test('address comparison: normalised (case, punctuation, spacing, St/Street, Unit, South Australia), only same / different / unable', () => {
  assert.equal(compareAddresses('Unit 3/12 Smith St, Kilburn SA 5084', '3 / 12 SMITH STREET KILBURN, South Australia 5084 AUSTRALIA'), ADDRESS_SAME);
  assert.equal(compareAddresses({ locationText: '12 Smith Rd Kilburn SA 5084' }, { location: { address1: '12 Smith Road', suburb: 'Kilburn', state: 'SA', postCode: '5084' } }), ADDRESS_SAME);
  assert.equal(compareAddresses('12 Smith St Kilburn SA 5084', '14 Smith St Kilburn SA 5084'), ADDRESS_DIFFERENT);
  assert.equal(compareAddresses('12 Smith St Kilburn SA 5084', '12 Smith St Blair Athol SA 5084'), ADDRESS_DIFFERENT);
  assert.equal(compareAddresses('12 Smith St Kilburn SA 5084', ''), ADDRESS_UNABLE);
  assert.equal(compareAddresses('12 Smith St Kilburn SA 5084', null), ADDRESS_UNABLE);
  assert.equal(compareAddresses('Smith Street Kilburn', 'Smith Street Kilburn'), ADDRESS_UNABLE, 'no number at all: not a comparable address');
  assert.equal(normalizeAddress('12, Smith St.,  KILBURN  S.A. 5084'), '12 smith street kilburn s a 5084');
});

const probe = (items, count = items.length) => ({ available: true, data: { count, items }, pagesFetched: 1, truncated: false });
const job = (id, jobNumber, status, extra = {}) => ({ id, jobNumber, status, client: { id: 'C1' }, location: null, completionDate: status === 'COMPLETED' ? '2026-01-01T00:00:00Z' : null, ...extra });
const CURRENT = job('T9', 9000, 'PENDING');
const history = (over = {}) => ({
  currentTask: CURRENT,
  clientDetail: { available: true, data: { id: 'C1', name: 'Example Customer', individual: true } },
  probes: { defaultList: probe([job('T1', 1000, 'COMPLETED'), job('T2', 2000, 'CANCELLED', { substatus: { name: 'Cancelled' } }), CURRENT]), archivedList: probe([]), siteList: null, locations: probe([]) },
  sameNameClients: probe([{ id: 'C1' }]),
  addressChecks: new Map([['T1', ADDRESS_SAME], ['T2', ADDRESS_SAME]]),
  occupant: 'Homeowner',
  ...over,
});

test('assessment with the address comparison: repeat only when an earlier completed job was at the same address; otherwise uncertain', () => {
  const a = analyzeClientHistory(history());
  assert.equal(a.assessment, 'repeat');
  assert.equal(a.earlierCompletedAtSameAddress, 1);
  assert.deepEqual(a.earlierJobs.map((t) => t.address), [ADDRESS_SAME, ADDRESS_SAME]);

  const cases = [
    ['different address', { addressChecks: new Map([['T1', ADDRESS_SAME], ['T2', ADDRESS_DIFFERENT]]) }, /different address — possibly another property/],
    ['unable to compare', { addressChecks: new Map([['T1', ADDRESS_UNABLE], ['T2', ADDRESS_SAME]]) }, /couldn't be compared/],
    ['not checked (missing)', { addressChecks: new Map([['T2', ADDRESS_SAME]]) }, /couldn't be compared/],
    ['duplicate refused', { sameNameClients: { available: false, status: 400, errorText: 'Invalid filter' } }, /same name \(AroFlo HTTP 400: Invalid filter\)/],
    ['possible duplicate', { sameNameClients: probe([{ id: 'C1' }, { id: 'C2' }]) }, /possible duplicate/],
    ['organisation', { clientDetail: { available: true, data: { id: 'C1', individual: false } } }, /organisation/],
    ['several sites', { probes: { ...history().probes, locations: probe([{ id: 'L1' }, { id: 'L2' }]) } }, /2 sites/],
  ];
  for (const [name, over, re] of cases) {
    const r = analyzeClientHistory(history(over));
    assert.equal(r.assessment, 'uncertain', name);
    assert.match(r.reasons.join(' '), re, name);
  }
  // Occupant never changes the assessment — every value, reference only.
  for (const occ of ['Homeowner', 'home owner', 'Owner', 'Owner-occupier', 'Tenant', 'Tennant', 'Landlord', 'Property Manager', 'Commercial', 'Something Else', null]) {
    const r = analyzeClientHistory(history({ occupant: occ }));
    assert.equal(r.assessment, 'repeat', `occupant ${occ}`);
    assert.doesNotMatch(r.reasons.join(' '), /occupant/i, `occupant ${occ}`);
  }
  // The strongest "no earlier job" wording.
  const none = analyzeClientHistory(history({ probes: { ...history().probes, defaultList: probe([CURRENT]) }, addressChecks: new Map() }));
  assert.equal(none.assessmentLabel, 'No earlier completed job found (this does not prove the customer is new)');
});

test('Lead Source recognised under both AroFlo field names; Occupant read', () => {
  const z = summarizeCustomFields({ available: true, data: { items: [{ customField: { name: 'Lead/Referral Source', value: 'Flyer' } }, { customField: { name: 'Occupant', value: 'Homeowner' } }] } }, 'CLIENTS');
  assert.deepEqual([z.leadSource, z.leadSourceField, z.occupant], ['Flyer', 'Lead/Referral Source', 'Homeowner']);
  const both = summarizeCustomFields({ available: true, data: { items: [{ customField: { name: 'Lead Source', value: 'Google' } }] } }, 'CLIENTS');
  assert.equal(both.leadSource, 'Google');
});

test('Valley View: the privacy-safe summary shows the matched suburb (not stripped as a street word)', async () => {
  const server = await startTestServer();
  try {
    const row = suburbCheckRow(2717, { location: null, locationText: '12 Example Street Valley View SA 5093 AUSTRALIA' });
    assert.deepEqual([row.proposed, row.summary], ['Valley View (5093)', '…Valley View SA 5093']);
    assert.ok(!row.summary.includes('Example') && !row.summary.includes('12'));
  } finally {
    server.close();
  }
});

// A fake AroFlo: current job 9000 for customer C1 at 12 Example Street; earlier completed jobs
// at the same and a different address; "Lead/Referral Source" on the customer; Occupant;
// the duplicate check refused for name.equals but answered for name.
const STREET_A = '12 Example Street';
const STREET_B = '40 Other Road';
const PHONE = '0412 345 678';
function fakeAroflo({ earlierCount = 2, equalsRefused = true, nameRefused = false } = {}) {
  const earlier = Array.from({ length: earlierCount }, (_, i) => ({ id: `E${i}`, jobNumber: 1000 + i, status: 'COMPLETED', completionDate: '2025-01-01T00:00:00Z', client: { id: 'C1' }, location: null }));
  const current = { id: 'T9', jobNumber: 9000, status: 'PENDING', client: { id: 'C1', name: 'Example Customer' }, location: null, locationText: `${STREET_A} Kilburn SA 5084 AUSTRALIA`, taskType: { name: 'Hot Water' } };
  return stubAroFlo(async (u) => {
    const p = u.searchParams;
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks' && p.get('clientId') === 'C1') {
      const all = p.get('status') === '4' ? [] : [...earlier, current];
      return jsonResponse(200, { count: all.length, items: p.get('page') === '1' ? all : [] });
    }
    if (u.pathname === '/v2/tasks') {
      return jsonResponse(200, { items: p.get('page') === '1' ? [{ id: 'T9', jobNumber: 9000, client: { id: 'C1' } }, { id: 'X1', jobNumber: 8999, client: { id: 'C2' } }] : [] });
    }
    if (u.pathname === '/v2/tasks/T9') return jsonResponse(200, current);
    const m = u.pathname.match(/^\/v2\/tasks\/E(\d+)$/);
    if (m) return jsonResponse(200, { id: `E${m[1]}`, location: null, locationText: m[1] === '1' ? `${STREET_B} Kilburn SA 5084` : `${STREET_A.toUpperCase()}, Kilburn, South Australia 5084` });
    if (u.pathname === '/v2/clients/C1') return jsonResponse(200, { id: 'C1', name: 'Example Customer', individual: true, phone: PHONE });
    if (u.pathname === '/v2/clients') {
      if (p.has('name.equals') && equalsRefused) return jsonResponse(400, { message: `Unknown filter name.equals — contact admin@example.com or ${PHONE}` });
      if (p.has('name') && nameRefused) return jsonResponse(400, { message: 'Invalid filter' });
      return jsonResponse(200, { items: [{ id: 'C1', name: 'Example Customer', phone: PHONE }] });
    }
    if (u.pathname === '/v2/locations') return jsonResponse(200, { count: 0, items: [] });
    if (u.pathname === '/v2/customfields/CLIENTS/C1' || u.pathname === '/v2/customfields/CLIENTS/C2') {
      return jsonResponse(200, {
        items: [
          { customField: { name: 'Lead/Referral Source', value: 'Flyer', type: 'dropdown', options: ['Flyer', 'Google', 'Referral'] } },
          { customField: { name: 'Occupant', value: 'Homeowner' } },
        ],
      });
    }
    if (u.pathname.startsWith('/v2/customfields/')) return jsonResponse(200, { items: [] });
    if (u.pathname === '/v2/invoices') return jsonResponse(200, { items: [] });
    return jsonResponse(404, {});
  });
}
const RECORDS = ['calls', 'jobs', 'sales', 'call_backs', 'audit_log', 'app_settings', 'list_items'];
const records = () => Object.fromEntries(RECORDS.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));

test('customer history route: address compared privately, extra requests counted, duplicate check falls back and reports a clean status', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const before = records();
    let stub = fakeAroflo();
    try {
      const d = (await server.request('GET', '/aroflo-test/customer-history?jn=9000')).data;
      const byJn = Object.fromEntries(d.analysis.earlierJobs.map((t) => [t.jobNumber, t.address]));
      assert.deepEqual(byJn, { 1000: ADDRESS_SAME, 1001: ADDRESS_DIFFERENT });
      assert.equal(d.analysis.assessment, 'uncertain', 'one earlier job at a different address');
      assert.equal(d.addressComparison.extraRequests, 2);
      assert.equal(d.totalCalls, stub.requests.length, 'every request counted');
      assert.ok(stub.requests.every((r) => r.method === 'GET' && r.body === undefined));
      assert.equal(d.analysis.sameNameCustomerRecords, 0, 'name.equals refused, then name answered');
      assert.deepEqual(stub.requests.filter((r) => r.path === '/v2/clients').map((r) => Object.keys(r.params).filter((k) => k.startsWith('name'))), [['name.equals'], ['name']]);
      assert.deepEqual([d.customFields[1].leadSource, d.customFields[1].leadSourceField], ['Flyer', 'Lead/Referral Source']);
      assert.equal(d.analysis.occupant, 'Homeowner');
      const json = JSON.stringify(d);
      for (const secret of [STREET_A, STREET_B, STREET_A.toUpperCase(), PHONE, 'test-token']) assert.ok(!json.includes(secret), `never returned: ${secret}`);
    } finally {
      stub.restore();
    }
    // Both duplicate-check forms refused: a clean status and message, contact details masked.
    stub = fakeAroflo({ nameRefused: true });
    try {
      const d = (await server.request('GET', '/aroflo-test/customer-history?jn=9000')).data;
      assert.match(d.analysis.reasons.join(' '), /same name \(AroFlo HTTP 400: Invalid filter\)/);
    } finally {
      stub.restore();
    }
    // More earlier jobs than the cap: the rest are "unable to compare" and stay uncertain.
    stub = fakeAroflo({ earlierCount: 14 });
    try {
      const d = (await server.request('GET', '/aroflo-test/customer-history?jn=9000')).data;
      assert.equal(d.addressComparison.extraRequests, 10);
      assert.equal(d.addressComparison.capped, true);
      assert.equal(d.analysis.earlierJobs.filter((t) => t.address === ADDRESS_UNABLE).length, 4);
      assert.equal(d.analysis.assessment, 'uncertain');
    } finally {
      stub.restore();
    }
    assert.deepEqual(records(), before, 'nothing written');
  } finally {
    server.close();
  }
});

test('Lead Source options tool: field names and options only — no customer, value or contact detail; admin only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = fakeAroflo();
    try {
      const d = (await server.request('GET', '/aroflo-test/lead-source-options')).data;
      assert.deepEqual(d.fields, [{ name: 'Lead/Referral Source', type: 'dropdown', seenOn: 2, optionsListed: true, options: ['Flyer', 'Google', 'Referral'] }]);
      assert.equal(d.customersRead, 2);
      assert.ok(stub.requests.every((r) => r.method === 'GET'));
      const json = JSON.stringify(d);
      for (const secret of ['Example Customer', 'C1', 'C2', PHONE, 'Homeowner']) assert.ok(!json.includes(secret), `never returned: ${secret}`);
    } finally {
      stub.restore();
    }
    const res = await server.request('POST', '/users', { name: 'Staff', email: 'staff-ls@test.local', password: 'password123', role: 'staff' });
    assert.equal(res.status, 201);
    server.setCookie('');
    await server.login('staff-ls@test.local', 'password123');
    assert.equal((await server.request('GET', '/aroflo-test/lead-source-options')).status, 403);
  } finally {
    server.close();
  }
});

test('call form: Lead Source read from "Lead/Referral Source" too — a suggestion only, never overwriting a staff choice', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const stub = fakeAroflo();
    try {
      const d = (await server.request('GET', '/aroflo/lookup?jn=9000')).data;
      assert.equal(d.leadSource, 'Flyer');
      // The normal lookup never runs the customer-history investigation.
      assert.ok(!stub.requests.some((r) => r.params.clientId || r.path === '/v2/clients' || r.path === '/v2/locations' || /^\/v2\/tasks\/E/.test(r.path)), 'no history requests');
      assert.deepEqual(stub.requests.map((r) => r.path).sort(), ['/v2/businessunits', '/v2/customfields/CLIENTS/C1', '/v2/invoices', '/v2/tasks', '/v2/tasks/T9'].sort());
    } finally {
      stub.restore();
    }
    const leadSources = [{ id: 1, name: 'Flyer' }, { id: 2, name: 'Google' }];
    const found = { found: true, taskType: '', leadSource: 'Flyer', suburb: null };
    const s = callLookupSummary(found, { leadSourceId: '' }, { trades: [], leadSources });
    assert.deepEqual([s.leadSource.suggestion, s.leadSource.alreadySet], [{ leadSourceId: 1, label: 'Flyer' }, false]);
    const staffChose = callLookupSummary(found, { leadSourceId: '2' }, { trades: [], leadSources });
    assert.equal(staffChose.leadSource.alreadySet, false, 'a different staff choice stays; only offered with Use this');
  } finally {
    server.close();
  }
});
