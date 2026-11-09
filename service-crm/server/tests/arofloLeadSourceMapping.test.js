import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { callLookupSummary } from '../../client/src/lib/arofloCallSuggest.js';

// AroFlo customer Lead Source -> CRM Lead Source mappings (Settings, admin
// only): stored in app_settings (backup/restore), mapping before exact name,
// unmapped values reference only, the two AroFlo fields ("Lead Source" and
// "Lead/Referral Source") never chosen between when they disagree, and the
// call form only ever suggests. Saving never changes a saved call.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { resolveLeadSourceValues } = await import('../src/aroflo/leadSourceMapping.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

// The real account's CRM Lead Source list.
const REAL = ['Google', 'Online Enquiry', 'Webchat', 'Referral', 'Repeat customer', 'Signage / vehicle', 'Word Of Mouth', 'Social Media', 'Flyer/Magnet', 'HiPages', 'Outreach', 'Other'];
async function setup(server) {
  await server.login();
  let b = ok(await server.request('GET', '/settings/bundle'));
  for (const name of REAL) if (!b.lists.lead_source.some((l) => l.name === name)) ok(await server.request('POST', '/settings/lists/lead_source', { name }));
  b = ok(await server.request('GET', '/settings/bundle'));
  const id = (name) => b.lists.lead_source.find((l) => l.name === name).id;
  return { b, id };
}
const APPROVED = (id) => [
  { arofloValue: 'Facebook/Socials', leadSourceId: id('Social Media') },
  { arofloValue: 'Meta', leadSourceId: id('Social Media') },
  { arofloValue: 'Flyer', leadSourceId: id('Flyer/Magnet') },
  { arofloValue: 'Hi Pages', leadSourceId: id('HiPages') },
];
const RECORDS = ['calls', 'jobs', 'sales', 'call_backs', 'audit_log', 'list_items'];
const records = () => Object.fromEntries(RECORDS.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));

test('settings: admin saves, edits and removes Lead Source mappings; one per AroFlo value; staff blocked; records untouched; backup and restore', async () => {
  const server = await startTestServer();
  try {
    const { id } = await setup(server);
    const before = records();
    const saved = ok(await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: APPROVED(id) })).mappings;
    assert.deepEqual(saved.map((m) => [m.arofloValue, m.leadSourceName]), [['Facebook/Socials', 'Social Media'], ['Meta', 'Social Media'], ['Flyer', 'Flyer/Magnet'], ['Hi Pages', 'HiPages']]);
    const bad = async (mappings, re) => {
      const res = await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings });
      assert.equal(res.status, 400);
      assert.match(res.data.error, re);
    };
    await bad([...APPROVED(id), { arofloValue: 'flyer ', leadSourceId: id('Other') }], /only have one mapping/);
    await bad([{ arofloValue: 'Online Ad', leadSourceId: 99999 }], /choose a CRM Lead Source/);
    await bad([{ arofloValue: '', leadSourceId: id('Other') }], /needs an AroFlo Lead Source value/);
    assert.equal(ok(await server.request('GET', '/settings/aroflo-lead-source-mappings')).mappings.length, 4, 'a rejected save changes nothing');
    // Edit one, remove one.
    const edited = APPROVED(id).filter((m) => m.arofloValue !== 'Meta').map((m) => (m.arofloValue === 'Flyer' ? { ...m, leadSourceId: id('Other') } : m));
    const after = ok(await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: edited })).mappings;
    assert.deepEqual(after.map((m) => [m.arofloValue, m.leadSourceName]), [['Facebook/Socials', 'Social Media'], ['Flyer', 'Other'], ['Hi Pages', 'HiPages']]);
    assert.deepEqual(records(), before, 'no call, job or list changed');
    // Backup and restore.
    const backup = ok(await server.request('GET', '/export/backup.json'));
    assert.ok(backup.tables.app_settings.some((r) => r.key === 'aroflo_lead_source_mappings'));
    ok(await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: [] }));
    ok(await server.request('POST', '/export/restore', backup));
    assert.equal(ok(await server.request('GET', '/settings/aroflo-lead-source-mappings')).mappings.length, 3, 'restored');
    // Staff blocked.
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-lsm@test.local', password: 'password123', role: 'staff' }));
    server.setCookie('');
    await server.login('staff-lsm@test.local', 'password123');
    assert.equal((await server.request('GET', '/settings/aroflo-lead-source-mappings')).status, 403);
    assert.equal((await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: [] })).status, 403);
  } finally {
    server.close();
  }
});

test('resolving: mapping, exact name, unmapped (Online Ad), and the two AroFlo fields — same result, conflict, one value', async () => {
  const server = await startTestServer();
  try {
    const { id } = await setup(server);
    ok(await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: APPROVED(id) }));
    const one = (value, field = 'Lead Source') => resolveLeadSourceValues([{ field, value }]);
    assert.deepEqual([one('Flyer').kind, one('Flyer').label, one('Flyer').source], ['mapped', 'Flyer/Magnet', 'mapping']);
    assert.equal(one('Hi Pages').label, 'HiPages');
    assert.equal(one('Facebook/Socials').label, 'Social Media');
    assert.equal(one('Meta').label, 'Social Media');
    for (const [v, want] of [['Google', 'Google'], ['Online Enquiry', 'Online Enquiry'], ['Webchat', 'Webchat'], ['Referral', 'Referral'], ['Word of Mouth', 'Word Of Mouth'], ['Outreach', 'Outreach'], ['Other', 'Other']]) {
      assert.deepEqual([one(v).kind, one(v).label, one(v).source], ['mapped', want, 'exact name'], v);
    }
    assert.deepEqual([one('Online Ad').kind, one('Online Ad').values], ['unmapped', [{ field: 'Lead Source', value: 'Online Ad', label: null }]]);
    assert.equal(resolveLeadSourceValues([]).kind, 'none');

    // Both AroFlo fields on one customer.
    const both = (a, b) => resolveLeadSourceValues([{ field: 'Lead Source', value: a }, { field: 'Lead/Referral Source', value: b }]);
    assert.deepEqual([both('Flyer', 'Flyer').kind, both('Flyer', 'Flyer').label], ['mapped', 'Flyer/Magnet'], 'same value');
    assert.deepEqual([both('Meta', 'Facebook/Socials').kind, both('Meta', 'Facebook/Socials').label], ['mapped', 'Social Media'], 'same mapped value -> one result');
    const conflict = both('Google', 'Flyer');
    assert.deepEqual([conflict.kind, conflict.leadSourceId], ['conflict', undefined]);
    assert.deepEqual(conflict.values, [{ field: 'Lead Source', value: 'Google', label: 'Google' }, { field: 'Lead/Referral Source', value: 'Flyer', label: 'Flyer/Magnet' }]);
    assert.equal(both('Online Ad', 'Google').kind, 'conflict', 'unmapped plus a different mapped value -> conflict');
    assert.equal(both('Online Ad', 'online  ad').kind, 'unmapped');

    // A mapped CRM Lead Source deleted later: ignored (never guessed) and flagged.
    ok(await server.request('DELETE', `/settings/list-items/${id('HiPages')}`));
    assert.equal(one('Hi Pages').kind, 'unmapped');
    const flagged = ok(await server.request('GET', '/settings/aroflo-lead-source-mappings')).mappings.find((m) => m.arofloValue === 'Hi Pages');
    assert.match(flagged.broken, /no longer exists/);
  } finally {
    server.close();
  }
});

test('lookup: both AroFlo fields read in one request; the call form suggests only, shows conflicts and unmapped values as reference', async () => {
  const server = await startTestServer();
  const original = global.fetch;
  try {
    const { b, id } = await setup(server);
    ok(await server.request('PUT', '/settings/aroflo-lead-source-mappings', { mappings: APPROVED(id) }));
    let fields = [{ name: 'Lead/Referral Source', value: 'Flyer' }];
    const requests = [];
    global.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'http://mock.test') return original(url, init);
      requests.push({ method: init?.method || 'GET', path: u.pathname });
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 4200 }] : [] });
      if (u.pathname === '/v2/tasks/T1') return jsonResponse(200, { id: 'T1', jobNumber: 4200, status: 'COMPLETED', taskType: { name: '' }, locationText: '', client: { id: 'C1' } });
      if (u.pathname === '/v2/customfields/CLIENTS/C1') return jsonResponse(200, { items: fields.map((f) => ({ customField: f })) });
      return jsonResponse(200, { items: [] });
    };
    const lookup = async () => ok(await server.request('GET', '/aroflo/lookup?jn=4200'));
    const before = records();

    let d = await lookup();
    assert.deepEqual([d.leadSource, d.leadSourceMatch.kind, d.leadSourceMatch.label], ['Flyer', 'mapped', 'Flyer/Magnet']);
    assert.equal(requests.filter((r) => r.path === '/v2/customfields/CLIENTS/C1').length, 1, 'both fields from one request');
    assert.ok(requests.every((r) => r.method === 'GET'));
    const leadSources = b.lists.lead_source.concat(REAL.filter((n) => !b.lists.lead_source.some((l) => l.name === n)).map((name) => ({ id: id(name), name })));
    let s = callLookupSummary(d, { leadSourceId: '' }, { trades: [], leadSources }).leadSource;
    assert.deepEqual([s.kind, s.suggestion, s.alreadySet], ['mapped', { leadSourceId: id('Flyer/Magnet'), label: 'Flyer/Magnet' }, false]);
    s = callLookupSummary(d, { leadSourceId: String(id('Google')) }, { trades: [], leadSources }).leadSource;
    assert.equal(s.alreadySet, false, 'a different staff choice is left as it is — the mapped value is only offered');

    fields = [{ name: 'Lead Source', value: 'Google' }, { name: 'Lead/Referral Source', value: 'Flyer' }];
    d = await lookup();
    s = callLookupSummary(d, { leadSourceId: '' }, { trades: [], leadSources }).leadSource;
    assert.deepEqual([s.kind, s.suggestion, s.values.map((v) => `${v.field}: ${v.value}`)], ['conflict', null, ['Lead Source: Google', 'Lead/Referral Source: Flyer']]);

    fields = [{ name: 'Lead Source', value: 'Online Ad' }];
    d = await lookup();
    s = callLookupSummary(d, { leadSourceId: '' }, { trades: [], leadSources }).leadSource;
    assert.deepEqual([s.kind, s.suggestion, s.arofloValue], ['unmapped', null, 'Online Ad']);

    fields = [{ name: 'Lead Source', value: 'Meta' }, { name: 'Lead/Referral Source', value: 'Facebook/Socials' }];
    d = await lookup();
    s = callLookupSummary(d, { leadSourceId: '' }, { trades: [], leadSources }).leadSource;
    assert.deepEqual([s.kind, s.suggestion.label], ['mapped', 'Social Media'], 'both fields mean the same CRM source');

    // The normal call lookup makes no customer-history requests.
    assert.ok(!requests.some((r) => r.path === '/v2/clients' || r.path === '/v2/locations'), 'no history check');
    assert.deepEqual(records(), before, 'looking up changed nothing');
  } finally {
    global.fetch = original;
    server.close();
  }
});
