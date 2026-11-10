import test from 'node:test';
import assert from 'node:assert/strict';
import { leadSourceDecision } from '../../client/src/lib/arofloCallSuggest.js';

// The Lead call's Lead Source order, case by case:
// 1. callback -> nothing; 2. confident repeat -> Repeat customer;
// 3. a genuine possibility of earlier completed work that can't be confirmed
//    -> left for staff with the reason; 4. otherwise -> the mapped AroFlo
//    customer-card source. Occupant is reference information only: every
//    Occupant value gets exactly the same result under the same history.
//    Organisation / several sites only make a customer ineligible for
//    AUTOMATIC Repeat customer — on their own they never block the mapped source.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const HOME = '12 Example Street Kilburn SA 5084 AUSTRALIA';
const SAME = '12 EXAMPLE ST, Kilburn, South Australia 5084';
const OTHER = '40 Other Road Prospect SA 5082';

// Every Occupant value: AroFlo's own spellings ("Tennant") plus any other value and none.
const OCCUPANTS = ['Homeowner', 'Owner', 'Tenant', 'Tennant', 'Landlord', 'Property Manager', 'Commercial', 'Some Other Value', null];
// Each history condition, with the outcome it must give for EVERY Occupant.
const CONDITIONS = {
  sameAddress: { history: { earlier: [{ addr: SAME }] }, lead: 'Repeat customer' },
  noHistory: { history: { earlier: [] }, lead: 'Flyer/Magnet' },
  quoteOnly: { history: { earlier: [{ addr: HOME, substatus: 'Quote declined' }] }, lead: 'Flyer/Magnet' },
  duplicate: { history: { earlier: [], sameName: 2 }, lead: 'staff', reason: /2 other AroFlo customer record\(s\) have exactly the same name/ },
  otherAddress: { history: { earlier: [{ addr: OTHER }] }, lead: 'staff', reason: /at a different address/ },
  uncomparable: { history: { earlier: [{ addr: '' }] }, lead: 'staff', reason: /couldn't be compared/ },
  incomplete: { history: { earlier: [], archivedFails: true }, lead: 'staff', reason: /Archived jobs couldn't be checked/ },
};

// Made-up customers: one per Occupant x condition, plus the organisation /
// multi-property cases. Job Numbers from 9200 up.
const C = {};
let next = 9200;
const add = (c) => {
  C[next] = { individual: true, sites: 0, sameName: 0, ...c, name: `Customer ${next}` };
  return next++;
};
const MATRIX = [];
for (const [cond, spec] of Object.entries(CONDITIONS)) {
  for (const occ of OCCUPANTS) MATRIX.push({ cond, occ, jn: add({ occupant: occ, ...spec.history }) });
}
const ORG_NEW = add({ occupant: 'Commercial', individual: false, earlier: [] });
const ORG_WORKED = add({ occupant: 'Commercial', individual: false, earlier: [{ addr: HOME }] });
const SITES_NEW = add({ occupant: 'Homeowner', earlier: [], sites: 3 });
const SITES_WORKED = add({ occupant: 'Tenant', earlier: [{ addr: OTHER }], sites: 2 });
let ejn = 2600;
for (const c of Object.values(C)) c.earlier = c.earlier.map((e) => ({ ...e, jn: ejn++ }));

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
      if (p.get('status') === '4') return C[cj].archivedFails ? jsonResponse(500, { message: 'down' }) : jsonResponse(200, { count: 0, items: [] });
      const all = [...C[cj].earlier.map((e) => ({ id: `E${e.jn}`, jobNumber: e.jn, status: 'COMPLETED', substatus: e.substatus ? { name: e.substatus } : null, completionDate: '2026-01-01T00:00:00Z', client: { id: `C${cj}` }, location: null })), current(cj)];
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
    if (m) {
      const items = [{ customField: { name: 'Lead Source', value: 'Flyer' } }];
      if (C[m[1]].occupant) items.push({ customField: { name: 'Occupant', value: C[m[1]].occupant } });
      return jsonResponse(200, { items });
    }
    return jsonResponse(200, { items: [] });
  };
  return () => (global.fetch = original);
}

const LEAD_SOURCES = [{ id: 1, name: 'Flyer/Magnet' }, { id: 2, name: 'Repeat customer' }];
const MAPPED = { arofloValue: 'Flyer', suggestion: { leadSourceId: 1, label: 'Flyer/Magnet' }, alreadySet: false, kind: 'mapped' };
// What the call form would do with the route's answer.
const formOutcome = (result) => {
  const d = leadSourceDecision(MAPPED, { jn: 'x', status: 'done', result }, { leadSourceId: '' }, LEAD_SOURCES);
  const base = { occupant: d.occupant ?? null };
  if (d.mode === 'normal') return { ...base, lead: 'Flyer/Magnet', warnings: d.warnings || [] };
  if (d.mode === 'repeat') return { ...base, lead: 'Repeat customer' };
  return { ...base, lead: d.mode === 'callback' ? 'none (callback)' : 'staff', reasons: d.reasons };
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

for (const [cond, spec] of Object.entries(CONDITIONS)) {
  test(`${cond}: every Occupant value gives the same result (${spec.lead})`, async () => {
    const results = [];
    for (const { occ, jn } of MATRIX.filter((x) => x.cond === cond)) {
      const raw = await check(jn);
      const o = formOutcome(raw);
      const label = `${cond} / ${occ ?? 'no Occupant'}`;
      assert.equal(o.lead, spec.lead, label);
      assert.equal(o.occupant, occ, `${label}: Occupant shown for reference`);
      if (spec.reason) assert.match(o.reasons.join(' '), spec.reason, label);
      const text = JSON.stringify([raw.reasons, raw.warnings, o.reasons, o.warnings]);
      assert.doesNotMatch(text, /occupant|tenant|tennant|landlord|homeowner|property manager/i, `${label}: Occupant never a reason or warning`);
      results.push({ lead: o.lead, reasons: o.reasons, warnings: o.warnings });
    }
    // Identical outcome, reasons and warnings across all Occupant values.
    for (const r of results) assert.deepEqual(r, results[0]);
  });
}

test('Organisation: no earlier work -> mapped source (note shown); earlier completed work -> staff', async () => {
  let o = formOutcome(await check(ORG_NEW));
  assert.equal(o.lead, 'Flyer/Magnet');
  assert.match(o.warnings.join(' '), /organisation/);
  o = formOutcome(await check(ORG_WORKED));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /1 earlier completed job/);
});

test('Multi-property: no earlier work -> mapped (note shown); earlier completed work elsewhere -> staff', async () => {
  let o = formOutcome(await check(SITES_NEW));
  assert.equal(o.lead, 'Flyer/Magnet');
  assert.match(o.warnings.join(' '), /3 sites\/properties/);
  o = formOutcome(await check(SITES_WORKED));
  assert.equal(o.lead, 'staff');
  assert.match(o.reasons.join(' '), /at a different address/);
});
