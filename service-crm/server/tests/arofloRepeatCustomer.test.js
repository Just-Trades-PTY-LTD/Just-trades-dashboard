import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { leadSourceDecision } from '../../client/src/lib/arofloCallSuggest.js';

// The automatic Repeat customer check on Lead calls (GET /api/aroflo/lead-history)
// and how the call form uses it, in the agreed order: callback -> no suggestion;
// confident repeat -> Repeat customer (original AroFlo source reference only);
// no earlier completed job -> the mapped AroFlo source as before; anything
// uncertain -> left for staff. Read-only; privacy-safe; suggestions only.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

const LEAD_SOURCES = [{ id: 1, name: 'Flyer/Magnet' }, { id: 2, name: 'Repeat customer' }, { id: 3, name: 'Google' }];
const MAPPED = { arofloValue: 'Flyer', suggestion: { leadSourceId: 1, label: 'Flyer/Magnet' }, alreadySet: false, kind: 'mapped' };
const done = (result) => ({ jn: '9000', status: 'done', result });

test('call form decision: checking, callback, repeat, no earlier job, uncertain, check unavailable', () => {
  const form = { leadSourceId: '' };
  assert.deepEqual(leadSourceDecision(MAPPED, null, form, LEAD_SOURCES), { mode: 'normal', original: 'Flyer' });
  assert.equal(leadSourceDecision(MAPPED, { jn: '9000', status: 'checking' }, form, LEAD_SOURCES).mode, 'checking', 'no suggestion while checking');
  const cb = leadSourceDecision(MAPPED, done({ found: true, kind: 'callback', reasons: ["its AroFlo task type is Call Back"] }), form, LEAD_SOURCES);
  assert.deepEqual([cb.mode, cb.suggestion], ['callback', undefined]);
  const rep = leadSourceDecision(MAPPED, done({ found: true, kind: 'repeat', earlierJob: { jobNumber: 2640, completed: '2026-11-02' } }), form, LEAD_SOURCES);
  assert.deepEqual([rep.mode, rep.suggestion, rep.alreadySet, rep.original, rep.earlierJob.jobNumber], ['repeat', { leadSourceId: 2, label: 'Repeat customer' }, false, 'Flyer', 2640]);
  assert.equal(leadSourceDecision(MAPPED, done({ found: true, kind: 'repeat' }), { leadSourceId: '2' }, LEAD_SOURCES).alreadySet, true);
  assert.equal(leadSourceDecision(MAPPED, done({ found: true, kind: 'repeat' }), { leadSourceId: '3' }, LEAD_SOURCES).alreadySet, false, 'a staff choice is left as it is');
  assert.equal(leadSourceDecision(MAPPED, done({ found: true, kind: 'no-earlier' }), form, LEAD_SOURCES).mode, 'normal', 'step 3: the mapped source applies');
  assert.equal(leadSourceDecision(MAPPED, done({ found: false, kind: 'unavailable' }), form, LEAD_SOURCES).mode, 'normal', 'check failed: as before');
  const unc = leadSourceDecision(MAPPED, done({ found: true, kind: 'uncertain', reasons: ['2 other AroFlo customer record(s) have exactly the same name'] }), form, LEAD_SOURCES);
  assert.deepEqual([unc.mode, unc.suggestion, unc.reasons.length], ['uncertain', undefined, 1]);
  const noRepeatOption = leadSourceDecision(MAPPED, done({ found: true, kind: 'repeat' }), form, LEAD_SOURCES.filter((l) => l.name !== 'Repeat customer'));
  assert.equal(noRepeatOption.mode, 'uncertain', 'never guessed when Settings has no Repeat customer option');
});

// A fake AroFlo with one customer per Job Number.
const PHONE = '0412 345 678';
const EMAIL = 'someone@example.com';
const HOME = '12 Example Street Kilburn SA 5084 AUSTRALIA';
const OTHER = '40 Other Road Prospect SA 5082';
const CUSTOMERS = {
  9001: { name: 'Repeat Person', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2640, status: 'COMPLETED', addr: '12 EXAMPLE ST, Kilburn, South Australia 5084' }] },
  9002: { name: 'New Person', individual: true, occupant: 'Homeowner', earlier: [] },
  9003: { name: 'Dup Landlord', individual: true, occupant: 'Landlord', earlier: [], sameName: 2 },
  9004: { name: 'BT Example', individual: false, occupant: 'Commercial', earlier: [{ jn: 2595, status: 'COMPLETED', addr: HOME }] },
  9005: { name: 'Two Homes', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2500, status: 'COMPLETED', addr: HOME }, { jn: 2501, status: 'COMPLETED', addr: OTHER }] },
  9006: { name: 'Callback Person', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2400, status: 'COMPLETED', addr: HOME }], taskType: 'Call Back' },
  9007: { name: 'Quote Only', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2300, status: 'COMPLETED', addr: HOME, substatus: 'Quote declined' }] },
};
function fakeAroflo() {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    requests.push({ method: init?.method || 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams), body: init?.body });
    const p = u.searchParams;
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    const current = (jn) => ({ id: `T${jn}`, jobNumber: Number(jn), status: 'PENDING', client: { id: `C${jn}`, name: CUSTOMERS[jn].name }, location: null, locationText: HOME, taskType: { name: CUSTOMERS[jn].taskType || 'Hot Water' } });
    const clientJn = (p.get('clientId') || '').replace('C', '');
    if (u.pathname === '/v2/tasks' && clientJn) {
      const c = CUSTOMERS[clientJn];
      const all = p.get('status') === '4' ? [] : [...c.earlier.map((e) => ({ id: `E${e.jn}`, jobNumber: e.jn, status: e.status, substatus: e.substatus ? { name: e.substatus } : null, completionDate: '2026-01-01T00:00:00Z', client: { id: `C${clientJn}` }, location: null })), current(clientJn)];
      return jsonResponse(200, { count: all.length, items: p.get('page') === '1' ? all : [] });
    }
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: p.get('page') === '1' ? Object.keys(CUSTOMERS).map((jn) => ({ id: `T${jn}`, jobNumber: Number(jn) })) : [] });
    let m = u.pathname.match(/^\/v2\/tasks\/T(\d+)$/);
    if (m) return jsonResponse(200, current(m[1]));
    m = u.pathname.match(/^\/v2\/tasks\/E(\d+)$/);
    if (m) {
      const e = Object.values(CUSTOMERS).flatMap((c) => c.earlier).find((x) => String(x.jn) === m[1]);
      return jsonResponse(200, { id: `E${m[1]}`, location: null, locationText: e.addr });
    }
    m = u.pathname.match(/^\/v2\/clients\/C(\d+)$/);
    if (m) return jsonResponse(200, { id: `C${m[1]}`, name: CUSTOMERS[m[1]].name, individual: CUSTOMERS[m[1]].individual, phone: PHONE, email: EMAIL });
    if (u.pathname === '/v2/clients') {
      const name = p.get('name.equals') || p.get('name');
      const jn = Object.keys(CUSTOMERS).find((k) => CUSTOMERS[k].name === name);
      return jsonResponse(200, { items: [{ id: `C${jn}` }, ...Array.from({ length: CUSTOMERS[jn]?.sameName || 0 }, (_, i) => ({ id: `DUP${i}` }))] });
    }
    if (u.pathname === '/v2/locations') return jsonResponse(200, { count: 0, items: [] });
    m = u.pathname.match(/^\/v2\/customfields\/CLIENTS\/C(\d+)$/);
    if (m) return jsonResponse(200, { items: [{ customField: { name: 'Lead Source', value: 'Flyer' } }, { customField: { name: 'Occupant', value: CUSTOMERS[m[1]].occupant } }] });
    if (u.pathname.startsWith('/v2/customfields/') || u.pathname === '/v2/invoices') return jsonResponse(200, { items: [] });
    return jsonResponse(404, {});
  };
  return { requests, restore: () => (global.fetch = original) };
}
const RECORDS = ['calls', 'jobs', 'sales', 'call_backs', 'audit_log', 'app_settings', 'list_items'];
const records = () => Object.fromEntries(RECORDS.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));

test('lead-history route: repeat, no earlier job, duplicate/landlord, business, two addresses, quote-only, AroFlo Call Back — privacy-safe, GET only, nothing written', async () => {
  const server = await startTestServer();
  const stub = fakeAroflo();
  try {
    await server.login();
    ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: [{ arofloTaskType: 'Call Back', kind: 'callback' }] }));
    const before = records();
    const check = async (jn) => ok(await server.request('GET', `/aroflo/lead-history?jn=${jn}`));

    let d = await check(9001);
    assert.deepEqual([d.kind, d.earlierJob.jobNumber], ['repeat', 2640], 'same address despite different formatting');
    assert.ok(d.requests >= 8 && Number.isFinite(d.elapsedMs));
    assert.equal((await check(9002)).kind, 'no-earlier');
    d = await check(9003);
    assert.equal(d.kind, 'uncertain');
    assert.match(d.reasons.join(' '), /same name/);
    assert.deepEqual([d.warnings, d.occupant], [[], 'Landlord'], 'Occupant is reference only');
    d = await check(9004);
    assert.equal(d.kind, 'uncertain');
    assert.match(d.reasons.join(' '), /1 earlier completed job/);
    assert.match(d.warnings.join(' '), /organisation/);
    d = await check(9005);
    assert.deepEqual([d.kind, /at a different address/.test(d.reasons.join(' '))], ['uncertain', true]);
    assert.equal((await check(9007)).kind, 'no-earlier', 'an earlier quote is not completed work');

    const before6 = stub.requests.length;
    d = await check(9006);
    assert.deepEqual([d.kind, d.reasons], ['callback', ['its AroFlo task type is Call Back']]);
    assert.ok(!stub.requests.slice(before6).some((r) => r.params.clientId), 'no history requests for a callback');

    assert.ok(stub.requests.every((r) => r.method === 'GET' && r.body === undefined), 'GET only');
    for (const jn of Object.keys(CUSTOMERS)) {
      const json = JSON.stringify(await check(jn));
      for (const secret of [PHONE, EMAIL, '12 Example', '40 Other', 'EXAMPLE ST', CUSTOMERS[jn].name, 'test-token']) assert.ok(!json.includes(secret), `${jn}: never returned: ${secret}`);
    }
    assert.deepEqual(records(), before, 'nothing written');
  } finally {
    stub.restore();
    server.close();
  }
});

test('callback evidence in the CRM: a Call Back entry\'s new Job Number, or a "Call back" call — no AroFlo request needed; the call being edited is ignored', async () => {
  const server = await startTestServer();
  const stub = fakeAroflo();
  try {
    await server.login();
    const b = ok(await server.request('GET', '/settings/bundle'));
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: '1111', newJobNumber: '9001', visitDate: '2026-11-01', technicianId: tech.id, creditedTechnicianId: tech.id, callBackReasonId: b.lists.callback_reason[0].id }));
    const n = stub.requests.length;
    let d = ok(await server.request('GET', '/aroflo/lead-history?jn=9001'));
    assert.deepEqual([d.kind, d.reasons, d.requests], ['callback', ["it's the new callback Job Number on a Technician & Sales Call Back entry"], 0]);
    assert.equal(stub.requests.length, n, 'no AroFlo request');

    const call = ok(await server.request('POST', '/calls', { callAt: '2026-11-02T09:00', direction: 'Inbound', callType: 'Call back', jobNumber: '9002', callBackReasonId: b.lists.callback_reason[0].id }));
    d = ok(await server.request('GET', '/aroflo/lead-history?jn=9002'));
    assert.deepEqual([d.kind, d.reasons], ['callback', ['it\'s on a Calls & Contacts "Call back" record']]);
    d = ok(await server.request('GET', `/aroflo/lead-history?jn=9002&excludeCallId=${call.id}`));
    assert.equal(d.kind, 'no-earlier', 'the call being edited is not evidence about itself');
    // The original Job Number on a Call Back entry is NOT callback evidence.
    assert.notEqual(ok(await server.request('GET', '/aroflo/lead-history?jn=1111')).kind, 'callback');
  } finally {
    stub.restore();
    server.close();
  }
});

test('access: Admin and Staff can run it from the call form; Technician accounts cannot; the normal lookup makes no history requests', async () => {
  const server = await startTestServer();
  const stub = fakeAroflo();
  try {
    await server.login();
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-rc@test.local', password: 'password123', role: 'staff' }));
    const tina = ok(await server.request('POST', '/users', { name: 'Tina', email: 'tina-rc@test.local', password: 'password123', role: 'staff' }));
    ok(await server.request('POST', `/users/${tina.id}/technician-link`, { technicianId: tech.id, confirm: true }));
    const n = stub.requests.length;
    ok(await server.request('GET', '/aroflo/lookup?jn=9001'));
    assert.ok(!stub.requests.slice(n).some((r) => r.params.clientId || r.path === '/v2/clients' || r.path === '/v2/locations'), 'normal lookup unchanged');
    server.setCookie('');
    await server.login('staff-rc@test.local', 'password123');
    assert.equal((await server.request('GET', '/aroflo/lead-history?jn=9001')).status, 200);
    server.setCookie('');
    await server.login('tina-rc@test.local', 'password123');
    assert.equal((await server.request('GET', '/aroflo/lead-history?jn=9001')).status, 403);
  } finally {
    stub.restore();
    server.close();
  }
});
