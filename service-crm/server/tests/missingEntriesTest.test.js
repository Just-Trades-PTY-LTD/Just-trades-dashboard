import test from 'node:test';
import assert from 'node:assert/strict';

// Missing entries check — read-only AroFlo test (Reports, Admin only).
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { all: dbAll } = await import('../src/db/index.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log', 'technicians', 'list_items'];
const dump = () => JSON.stringify(TABLES.map((t) => dbAll(`SELECT * FROM ${t} ORDER BY rowid`)));

const TASKS = [
  { id: 'T6', jobNumber: 5006, status: 'COMPLETED', taskType: { name: 'Service' }, timestampCreated: '2026-11-20T09:00:00', location: { suburb: 'Glenelg', street: '1 Secret St' } },
  { id: 'T5', jobNumber: 5005, status: 'COMPLETED', timestampCreated: '2026-11-01T09:00:00', completionDate: '2026-11-10' },
  { id: 'T4', jobNumber: 5004, status: 'IN PROGRESS', timestampCreated: '2026-11-15T09:00:00' },
  { id: 'T3', jobNumber: 5003, status: 'PENDING', timestampCreated: '2026-11-15T09:00:00' },
  { id: 'T2', jobNumber: 5002, status: 'PENDING', taskType: { name: 'Fault' }, timestampCreated: '2026-11-15T09:00:00', location: { suburb: 'Norwood' } },
  { id: 'T1', jobNumber: 5001, status: 'COMPLETED', timestampCreated: '2026-11-15T09:00:00', completionDate: '2026-11-24' },
];
const tylor = { givenName: 'Tylor', familyName: 'Smith', email: 'private@x', mobile: '0400' };
const LABOURS = {
  T1: [{ user: tylor, date: '2026-11-24', costRate: 99 }, { user: tylor, date: '2026-11-24' }, { user: tylor, date: '2026-11-25' }],
  T2: [{ user: tylor, date: '2026-11-24' }],
  T3: [{ user: { givenName: 'Office', familyName: 'Admin' }, date: '2026-11-24' }],
  T4: [{ user: tylor, date: '2026-11-24' }],
  T5: [{ user: tylor, date: '2026-11-10' }],
  T6: [{ user: tylor, date: '2026-11-24' }],
};

function fakeAroflo() {
  const original = global.fetch;
  const methods = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    methods.push(init?.method || 'GET');
    const p = u.pathname;
    if (p === '/v2/businessunits') return json(200, { items: [{ id: 'BU-1' }] });
    if (p === '/v2/labours' || p === '/v2/timesheets') return json(404, null);
    if (p === '/v2/schedules') return json(400, { message: 'zoneId is required' });
    if (p === '/v2/tasks') return json(200, { count: TASKS.length, items: u.searchParams.get('page') === '2' ? [] : TASKS });
    const m = p.match(/^\/v2\/tasks\/(T\d)\/labours$/);
    if (m) return json(200, { items: LABOURS[m[1]] || [] });
    return json(404, null);
  };
  return { methods, restore: () => (global.fetch = original) };
}

test('Missing entries test: one row per Job Number, CRM matches, only CRM technicians, GET only, nothing written', async () => {
  const server = await startTestServer();
  const fake = fakeAroflo();
  try {
    await server.login();
    const b = ok(await server.request('GET', '/settings/bundle'));
    const plumbing = b.trades.find((t) => t.name === 'Plumbing');
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tylor' }));
    const job = (jn, extra = {}) =>
      server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made', visitDate: '2026-11-01', technicianId: tech.id, jobNumber: jn, tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified', invoiceNumber: `I${jn}`, invoiceDate: '2026-11-01', saleValueExGst: 100, ...extra,
      });
    ok(await job('5001'));
    ok(await job('4000'));
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: '4000', newJobNumber: '5004', dateLogged: '2026-11-20', creditedTechnicianId: tech.id, invoiceNumber: 'I5004', invoiceDate: '2026-11-20', saleValueExGst: 500 }));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: '4000', newJobNumber: '5006', visitDate: '2026-11-24', technicianId: tech.id, creditedTechnicianId: tech.id, reasonId: b.lists.callback_reason[0].id, comments: '' }));

    const before = dump();
    const r = ok(await server.request('GET', '/aroflo-test/missing-entries?from=2026-11-24&to=2026-11-24'));
    const byJn = Object.fromEntries(r.jobs.map((j) => [j.jobNumber, j]));
    assert.deepEqual(Object.keys(byJn).sort(), ['5001', '5002', '5004', '5006'], '5003 is not a CRM technician; 5005 is outside the dates');
    assert.deepEqual(r.summary, { jobNumbers: 4, accountedFor: 3, missing: 1 });
    assert.deepEqual(byJn['5001'].dates, ['2026-11-24'], 'two visits on the day, one Job Number; the 25th is outside the range');
    assert.deepEqual(byJn['5001'].accountedFor, ['New Job entry']);
    assert.deepEqual(byJn['5004'].accountedFor, ['Approved-quote install']);
    assert.deepEqual(byJn['5006'].accountedFor, ['Call Back']);
    assert.deepEqual(byJn['5002'].accountedFor, []);
    assert.equal(byJn['5002'].suburb, 'Norwood');
    assert.deepEqual(byJn['5002'].technicians, ['Tylor']);
    assert.deepEqual(r.unmatchedLabourNames, [{ name: 'Office Admin', entries: 1 }]);
    assert.ok(r.method.dateFilterTests.every((t) => !t.available || !t.filterHonoured), 'no fake filter is reported as working');
    const text = JSON.stringify(r);
    for (const secret of ['Secret St', 'private@x', '0400', 'costRate', 'test-token']) assert.ok(!text.includes(secret), `never returns ${secret}`);
    assert.ok(fake.methods.every((m) => m === 'GET'), 'AroFlo: GET only');
    assert.equal(dump(), before, 'no CRM record written');

    assert.equal((await server.request('GET', '/aroflo-test/missing-entries?from=2026-11-01&to=2026-12-15')).status, 400, 'range limit');
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-me@test.local', password: 'password123', role: 'staff' }));
    await server.login('staff-me@test.local', 'password123');
    assert.equal((await server.request('GET', '/aroflo-test/missing-entries?from=2026-11-24&to=2026-11-24')).status, 403, 'Admin only');
  } finally {
    fake.restore();
    server.close();
  }
});
