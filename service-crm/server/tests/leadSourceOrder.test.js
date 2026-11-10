import test from 'node:test';
import assert from 'node:assert/strict';
import { leadSourceDecision } from '../../client/src/lib/arofloCallSuggest.js';

// The Lead call's Lead Source order, case by case:
// 1. callback -> nothing; 2. confident repeat -> Repeat customer;
// 3. a genuine possibility of earlier completed work that can't be confirmed
//    -> left for staff with the reason; 4. otherwise -> the mapped AroFlo
//    customer-card source. Occupant / organisation / several sites only make
//    a customer ineligible for AUTOMATIC Repeat customer — on their own they
//    never block the mapped source (shown as information).
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const HOME = '12 Example Street Kilburn SA 5084 AUSTRALIA';
const OTHER = '40 Other Road Prospect SA 5082';
// One made-up customer per Job Number.
const C = {
  // Occupant only, no earlier work -> mapped source.
  9101: { name: 'Tenant Only', individual: true, occupant: 'Tennant', earlier: [] },
  9102: { name: 'Landlord Only', individual: true, occupant: 'Landlord', earlier: [] },
  9103: { name: 'Commercial Only', individual: true, occupant: 'Commercial', earlier: [] },
  // Organisation, no earlier work -> mapped source.
  9104: { name: 'Org No History', individual: false, occupant: 'Commercial', earlier: [] },
  // Possible duplicate records -> staff.
  9105: { name: 'Duplicate Name', individual: true, occupant: 'Homeowner', earlier: [], sameName: 2 },
  // Multi-property: several sites, no earlier work -> mapped; with earlier completed work -> staff.
  9106: { name: 'Many Sites New', individual: true, occupant: 'Homeowner', earlier: [], sites: 3 },
  9107: { name: 'Many Sites Worked', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2601, addr: OTHER }], sites: 2 },
  // Same-address repeat -> Repeat customer.
  9108: { name: 'Same Address', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2602, addr: '12 EXAMPLE ST, Kilburn, South Australia 5084' }] },
  // Different-address history -> staff.
  9109: { name: 'Other Address', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2603, addr: OTHER }] },
  // No history at all -> mapped.
  9110: { name: 'No History', individual: true, occupant: 'Homeowner', earlier: [] },
  // Business / landlord with earlier completed work -> staff.
  9111: { name: 'Org Worked', individual: false, occupant: 'Commercial', earlier: [{ jn: 2604, addr: HOME }] },
  9112: { name: 'Landlord Worked', individual: true, occupant: 'Landlord', earlier: [{ jn: 2605, addr: HOME }] },
  // Address of the earlier job can't be compared -> staff.
  9113: { name: 'No Address', individual: true, occupant: 'Homeowner', earlier: [{ jn: 2606, addr: '' }] },
  // Only an earlier quote (not completed work) -> mapped.
  9114: { name: 'Quote Only', individual: true, occupant: 'Tennant', earlier: [{ jn: 2607, addr: HOME, substatus: 'Quote declined' }] },
};
function fakeAroflo() {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    const p = u.searchParams;
    const current = (jn) => ({ id: `T${jn}`, jobNumber: Number(jn), status: 'PENDING', client: { id: `C${jn}`, name: C[jn].name }, location: null, locationText: HOME, taskType: { name: 'Hot Water' } });
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    const cj = (p.get('clientId') || '').replace('C', '');
    if (u.pathname === '/v2/tasks' && cj) {
      const all = p.get('status') === '4' ? [] : [...C[cj].earlier.map((e) => ({ id: `E${e.jn}`, jobNumber: e.jn, status: 'COMPLETED', substatus: e.substatus ? { name: e.substatus } : null, completionDate: '2026-01-01T00:00:00Z', client: { id: `C${cj}` }, location: null })), current(cj)];
      return jsonResponse(200, { count: all.length, items: p.get('page') === '1' ? all : [] });
    }
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: p.get('page') === '1' ? Object.keys(C).map((jn) => ({ id: `T${jn}`, jobNumber: Number(jn) })) : [] });
    let m = u.pathname.match(/^\/v2\/tasks\/T(\d+)$/);
    if (m) return jsonResponse(200, current(m[1]));
    m = u.pathname.match(/^\/v2\/tasks\/E(\d+)$/);
    if (m) return jsonResponse(200, { id: `E${m[1]}`, location: null, locationText: Object.values(C).flatMap((c) => c.earlier).find((e) => String(e.jn) === m[1]).addr });
    m = u.pathname.match(/^\/v2\/clients\/C(\d+)$/);
    if (m) return jsonResponse(200, { id: `C${m[1]}`, name: C[m[1]].name, individual: C[m[1]].individual });
    if (u.pathname === '/v2/clients') {
      const jn = Object.keys(C).find((k) => C[k].name === (p.get('name.equals') || p.get('name')));
      return jsonResponse(200, { items: [{ id: `C${jn}` }, ...Array.from({ length: C[jn]?.sameName || 0 }, (_, i) => ({ id: `DUP${i}` }))] });
    }
    if (u.pathname === '/v2/locations') {
      const n = C[cj]?.sites || 0;
      return jsonResponse(200, { count: n, items: Array.from({ length: n }, (_, i) => ({ id: `L${i}` })) });
    }
    m = u.pathname.match(/^\/v2\/customfields\/CLIENTS\/C(\d+)$/);
    if (m) return jsonResponse(200, { items: [{ customField: { name: 'Lead Source', value: 'Flyer' } }, { customField: { name: 'Occupant', value: C[m[1]].occupant } }] });
    return jsonResponse(200, { items: [] });
  };
  return () => (global.fetch = original);
}

const LEAD_SOURCES = [{ id: 1, name: 'Flyer/Magnet' }, { id: 2, name: 'Repeat customer' }];
const MAPPED = { arofloValue: 'Flyer', suggestion: { leadSourceId: 1, label: 'Flyer/Magnet' }, alreadySet: false, kind: 'mapped' };
// What the call form would do with the route's answer.
const formOutcome = (result) => {
  const d = leadSourceDecision(MAPPED, { jn: 'x', status: 'done', result }, { leadSourceId: '' }, LEAD_SOURCES);
  if (d.mode === 'normal') return { lead: 'Flyer/Magnet', warnings: d.warnings || [] };
  if (d.mode === 'repeat') return { lead: 'Repeat customer' };
  return { lead: d.mode === 'callback' ? 'none (callback)' : 'staff', reasons: d.reasons };
};

let server;
let restore;
test.before(async () => {
  server = await startTestServer();
  restore = fakeAroflo();
  await server.login();
});
test.after(() => {
  restore();
  server.close();
});
const check = async (jn) => {
  const res = await server.request('GET', `/aroflo/lead-history?jn=${jn}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};

test('Occupant on its own never blocks the mapped source (Tennant, Landlord, Commercial, no earlier work)', async () => {
  for (const [jn, occ] of [[9101, 'Tennant'], [9102, 'Landlord'], [9103, 'Commercial']]) {
    const d = await check(jn);
    assert.equal(d.kind, 'no-earlier', occ);
    const o = formOutcome(d);
    assert.equal(o.lead, 'Flyer/Magnet', occ);
    assert.deepEqual(o.warnings, [`Occupant: ${occ} — not eligible for automatic Repeat customer classification.`]);
  }
  // Only an earlier QUOTE (not completed work), Tennant: still the mapped source.
  assert.equal(formOutcome(await check(9114)).lead, 'Flyer/Magnet');
});

test('Organisation with complete history and no earlier completed work -> mapped source (warning shown)', async () => {
  const o = formOutcome(await check(9104));
  assert.equal(o.lead, 'Flyer/Magnet');
  assert.match(o.warnings.join(' '), /organisation — not eligible for automatic Repeat customer classification/);
});

test('Possible duplicate customer records -> left for staff, even with no earlier job on this record (like Chirag)', async () => {
  const o = formOutcome(await check(9105));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /2 other AroFlo customer record\(s\) have exactly the same name/);
});

test('Multi-property: no earlier work -> mapped (warning); earlier completed work elsewhere -> staff', async () => {
  let o = formOutcome(await check(9106));
  assert.equal(o.lead, 'Flyer/Magnet');
  assert.match(o.warnings.join(' '), /3 sites\/properties/);
  o = formOutcome(await check(9107));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /1 earlier completed job.*at a different address/);
});

test('Same-address repeat -> Repeat customer (like Dan and Joyce)', async () => {
  const d = await check(9108);
  assert.deepEqual([d.kind, d.earlierJob.jobNumber], ['repeat', 2602]);
  assert.equal(formOutcome(d).lead, 'Repeat customer');
});

test('Different-address or uncomparable history -> left for staff', async () => {
  let o = formOutcome(await check(9109));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /at a different address/);
  o = formOutcome(await check(9113));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /couldn't be compared/);
});

test('Business or landlord WITH earlier completed work -> left for staff (like BT Enviro), even at the same address', async () => {
  for (const jn of [9111, 9112]) {
    const o = formOutcome(await check(jn));
    assert.equal(o.lead, 'staff', String(jn));
    assert.match(o.reasons.join(' '), /1 earlier completed job/);
  }
});

test('No history at all -> mapped source, no warnings', async () => {
  const d = await check(9110);
  assert.deepEqual([d.kind, d.warnings], ['no-earlier', []]);
  assert.deepEqual(formOutcome(d), { lead: 'Flyer/Magnet', warnings: [] });
});
