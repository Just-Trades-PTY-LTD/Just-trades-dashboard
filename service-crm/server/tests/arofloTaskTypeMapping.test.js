import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { planNewJobPrefill, prefillStep } from '../../client/src/lib/arofloPrefill.js';
import { callLookupSummary } from '../../client/src/lib/arofloCallSuggest.js';
import { prefillConfirmation } from '../../client/src/lib/arofloDisplay.js';

// AroFlo task type -> CRM Trade / Job type mappings (Settings, admin only):
// stored in app_settings, an explicit mapping overrides the exact-name
// fallback, Trade-only and Call Back kinds never guess, broken mappings are
// ignored and flagged, both forms use one server-side answer, and saving a
// mapping never changes any saved call or job.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { resolveTaskType } = await import('../src/aroflo/taskTypeMapping.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

// The real account's shape: Heating & Cooling and Plumbing job types.
async function setup(server) {
  await server.login();
  let b = ok(await server.request('GET', '/settings/bundle'));
  const ensure = async (tradeName, names) => {
    let t = b.trades.find((x) => x.name === tradeName);
    if (!t) t = { ...ok(await server.request('POST', '/settings/trades', { name: tradeName })), jobTypes: [] };
    for (const n of names) if (!t.jobTypes.some((j) => j.name === n)) ok(await server.request('POST', `/settings/trades/${t.id}/job-types`, { name: n }));
  };
  await ensure('Heating & Cooling', ['Installation', 'Servicing', 'Faults']);
  await ensure('Plumbing', ['Gas Fitting', 'Burst Pipe', 'Hot Water']);
  b = ok(await server.request('GET', '/settings/bundle'));
  const trade = (name) => b.trades.find((t) => t.name === name);
  const jt = (tradeName, name) => trade(tradeName).jobTypes.find((j) => j.name === name);
  return { b, trade, jt };
}

const APPROVED = ({ trade, jt }) => [
  { arofloTaskType: 'Air Conditioning Installation', kind: 'full', tradeId: trade('Heating & Cooling').id, jobTypeId: jt('Heating & Cooling', 'Installation').id },
  { arofloTaskType: 'Air Conditioning Servicing', kind: 'full', tradeId: trade('Heating & Cooling').id, jobTypeId: jt('Heating & Cooling', 'Servicing').id },
  { arofloTaskType: 'Air Conditioning Faults', kind: 'full', tradeId: trade('Heating & Cooling').id, jobTypeId: jt('Heating & Cooling', 'Faults').id },
  { arofloTaskType: 'Ongoing Servicing', kind: 'full', tradeId: trade('Heating & Cooling').id, jobTypeId: jt('Heating & Cooling', 'Servicing').id },
  { arofloTaskType: 'Gas Appliances', kind: 'full', tradeId: trade('Plumbing').id, jobTypeId: jt('Plumbing', 'Gas Fitting').id },
  { arofloTaskType: 'Gas and Water Piping', kind: 'tradeOnly', tradeId: trade('Plumbing').id, choiceJobTypeIds: [jt('Plumbing', 'Gas Fitting').id, jt('Plumbing', 'Burst Pipe').id] },
  { arofloTaskType: 'Call Back', kind: 'callback' },
];
const RECORDS = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log', 'trades', 'job_types'];
const records = () => Object.fromEntries(RECORDS.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));

test('settings: admin saves, edits and removes mappings; validation never allows an ambiguous or invalid mapping; records untouched', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const before = records();
    const saved = ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: APPROVED(ctx) })).mappings;
    assert.equal(saved.length, 7);
    assert.deepEqual(saved.find((m) => m.arofloTaskType === 'Gas and Water Piping').choices.map((c) => c.name), ['Gas Fitting', 'Burst Pipe']);
    assert.deepEqual(ok(await server.request('GET', '/settings/aroflo-task-type-mappings')).mappings.map((m) => m.arofloTaskType), APPROVED(ctx).map((m) => m.arofloTaskType));

    const bad = async (mappings, re) => {
      const res = await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings });
      assert.equal(res.status, 400, JSON.stringify(mappings));
      assert.match(res.data.error, re);
    };
    const hc = ctx.trade('Heating & Cooling');
    await bad([...APPROVED(ctx), { arofloTaskType: 'air-conditioning  faults', kind: 'full', tradeId: hc.id, jobTypeId: ctx.jt('Heating & Cooling', 'Servicing').id }], /only have one mapping/);
    await bad([{ arofloTaskType: 'X', kind: 'full', tradeId: hc.id, jobTypeId: ctx.jt('Plumbing', 'Gas Fitting').id }], /Job type within Heating & Cooling/);
    await bad([{ arofloTaskType: 'X', kind: 'full', tradeId: 99999, jobTypeId: 1 }], /choose a Trade/);
    await bad([{ arofloTaskType: 'X', kind: 'tradeOnly', tradeId: ctx.trade('Plumbing').id, choiceJobTypeIds: [ctx.jt('Plumbing', 'Gas Fitting').id] }], /at least two/);
    await bad([{ arofloTaskType: 'X', kind: 'tradeOnly', tradeId: ctx.trade('Plumbing').id, choiceJobTypeIds: [ctx.jt('Plumbing', 'Gas Fitting').id, ctx.jt('Heating & Cooling', 'Faults').id] }], /must belong to Plumbing/);
    await bad([{ arofloTaskType: '', kind: 'callback' }], /task type name/);
    await bad([{ arofloTaskType: 'X', kind: 'guess' }], /choose what it maps to/);
    assert.equal(ok(await server.request('GET', '/settings/aroflo-task-type-mappings')).mappings.length, 7, 'a rejected save changes nothing');

    // Edit one, remove one.
    const edited = APPROVED(ctx).filter((m) => m.arofloTaskType !== 'Ongoing Servicing');
    edited[0] = { ...edited[0], jobTypeId: ctx.jt('Heating & Cooling', 'Faults').id };
    const after = ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: edited })).mappings;
    assert.equal(after.length, 6);
    assert.equal(after[0].jobTypeName, 'Faults');
    assert.deepEqual(records(), before, 'no call, job, sale or list changed');

    // Staff can't read or change mappings.
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-map@test.local', password: 'password123', role: 'staff' }));
    server.setCookie('');
    await server.login('staff-map@test.local', 'password123');
    assert.equal((await server.request('GET', '/settings/aroflo-task-type-mappings')).status, 403);
    assert.equal((await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: [] })).status, 403);
  } finally {
    server.close();
  }
});

test('resolving a task type: mapping overrides exact name; Trade-only and Call Back never guess; unmapped and broken stay blank', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    // Exact-name fallback before any mapping.
    assert.deepEqual(resolveTaskType('Hot Water'), { taskType: 'Hot Water', kind: 'full', source: 'exact name', tradeId: ctx.trade('Plumbing').id, jobTypeId: ctx.jt('Plumbing', 'Hot Water').id, label: 'Plumbing — Hot Water', choices: [] });
    assert.equal(resolveTaskType('Air Conditioning Faults').kind, 'none');
    ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', {
      mappings: [...APPROVED(ctx), { arofloTaskType: 'Hot Water', kind: 'full', tradeId: ctx.trade('Plumbing').id, jobTypeId: ctx.jt('Plumbing', 'Burst Pipe').id }],
    }));
    assert.deepEqual(
      [resolveTaskType('Air Conditioning Faults').label, resolveTaskType('Air Conditioning Faults').source],
      ['Heating & Cooling — Faults', 'mapping']
    );
    assert.equal(resolveTaskType('ONGOING servicing').label, 'Heating & Cooling — Servicing', 'case and spacing tolerant');
    assert.equal(resolveTaskType('Hot Water').label, 'Plumbing — Burst Pipe', 'an explicit mapping overrides the exact-name match');
    const piping = resolveTaskType('Gas and Water Piping');
    assert.deepEqual([piping.kind, piping.tradeId, piping.jobTypeId, piping.choices.map((c) => c.name)], ['tradeOnly', ctx.trade('Plumbing').id, null, ['Gas Fitting', 'Burst Pipe']]);
    const cb = resolveTaskType('Call Back');
    assert.deepEqual([cb.kind, cb.tradeId, cb.jobTypeId], ['callback', null, null]);
    for (const unmapped of ['After Hours Call Out', 'Service', '']) assert.equal(resolveTaskType(unmapped).kind, 'none', unmapped);

    // A mapped Job type deleted later: ignored (never guessed) and flagged.
    ok(await server.request('DELETE', `/settings/job-types/${ctx.jt('Heating & Cooling', 'Faults').id}`));
    assert.equal(resolveTaskType('Air Conditioning Faults').kind, 'none');
    const flagged = ok(await server.request('GET', '/settings/aroflo-task-type-mappings')).mappings.find((m) => m.arofloTaskType === 'Air Conditioning Faults');
    assert.match(flagged.broken, /Job type no longer exists/);
  } finally {
    server.close();
  }
});

test('both forms get the same answer from the lookup; mappings are in backup and come back on restore', async () => {
  const server = await startTestServer();
  const original = global.fetch;
  try {
    const ctx = await setup(server);
    ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: APPROVED(ctx) }));
    let taskType = 'Air Conditioning Servicing';
    global.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'http://mock.test') return original(url, init);
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 4100 }] : [] });
      if (u.pathname === '/v2/tasks/T1') return jsonResponse(200, { id: 'T1', jobNumber: 4100, status: 'COMPLETED', taskType: { name: taskType }, locationText: '', client: { id: 'C1' } });
      return jsonResponse(200, { items: [] });
    };
    let d = ok(await server.request('GET', '/aroflo/lookup?jn=4100'));
    assert.deepEqual([d.taskTypeMatch.kind, d.taskTypeMatch.label, d.taskTypeMatch.source], ['full', 'Heating & Cooling — Servicing', 'mapping']);
    taskType = 'Call Back';
    d = ok(await server.request('GET', '/aroflo/lookup?jn=4100'));
    assert.equal(d.taskTypeMatch.kind, 'callback');

    const backup = ok(await server.request('GET', '/export/backup.json'));
    assert.ok(backup.tables.app_settings.some((r) => r.key === 'aroflo_task_type_mappings'), 'included in the backup');
    ok(await server.request('PUT', '/settings/aroflo-task-type-mappings', { mappings: [] }));
    ok(await server.request('POST', '/export/restore', backup));
    assert.equal(ok(await server.request('GET', '/settings/aroflo-task-type-mappings')).mappings.length, 7, 'restored');
  } finally {
    global.fetch = original;
    server.close();
  }
});

// Form logic (client libraries) with the server's resolved answer.
const trades = [
  { id: 1, name: 'Plumbing', jobTypes: [{ id: 11, name: 'Gas Fitting' }, { id: 12, name: 'Burst Pipe' }] },
  { id: 3, name: 'Heating & Cooling', jobTypes: [{ id: 31, name: 'Servicing' }] },
];
const form = (over = {}) => ({ kind: 'new_job_no_sale', visitDate: '2026-11-03', suburb: '', comments: '', tradeId: '', jobTypeId: '', ...over });
const now = { date: '2026-11-09', time: '09:00' };
const found = (taskTypeMatch, taskType) => ({ found: true, status: 'COMPLETED', suburb: null, taskType, taskTypeMatch, invoices: [] });
const FULL = { kind: 'full', source: 'mapping', tradeId: 3, jobTypeId: 31, label: 'Heating & Cooling — Servicing', choices: [] };
const TRADE_ONLY = { kind: 'tradeOnly', source: 'mapping', tradeId: 1, jobTypeId: null, label: 'Plumbing', choices: [{ jobTypeId: 11, name: 'Gas Fitting' }, { jobTypeId: 12, name: 'Burst Pipe' }] };
const CALLBACK = { kind: 'callback', source: 'mapping', tradeId: null, jobTypeId: null, label: null, choices: [] };

test('Technician & Sales: a mapped type fills blank Trade / Job type; Trade-only fills the Trade and lists the choices; Call Back fills nothing; staff values never overwritten', () => {
  let r = prefillStep({ result: found(FULL, 'Ongoing Servicing'), form: form(), previous: {}, now, trades, technicians: [] });
  assert.deepEqual([r.patch.tradeId, r.patch.jobTypeId], ['3', '31']);

  r = prefillStep({ result: found(TRADE_ONLY, 'Gas and Water Piping'), form: form(), previous: {}, now, trades, technicians: [] });
  assert.equal(r.patch.tradeId, '1');
  assert.ok(!('jobTypeId' in r.patch), 'Job type left for staff');
  assert.ok(r.plan.notes.includes('AroFlo task type: Gas and Water Piping — choose Gas Fitting or Burst Pipe.'));
  assert.match(prefillConfirmation(Object.keys(r.filled)), /: Trade\.$/, 'confirmation says Trade, not Trade / Job type');

  r = prefillStep({ result: found(CALLBACK, 'Call Back'), form: form(), previous: {}, now, trades, technicians: [] });
  assert.ok(!('tradeId' in r.patch) && !('jobTypeId' in r.patch) && !('kind' in r.patch), 'no Trade, no Job type, entry type untouched');
  assert.match(r.plan.notes.join(' '), /Call Back.*entry type isn't changed/);

  // Staff already chose something: never overwritten, offered instead.
  const plan = planNewJobPrefill({ result: found(TRADE_ONLY, 'Gas and Water Piping'), form: form({ tradeId: '3', jobTypeId: '31' }), now, trades, technicians: [] });
  assert.ok(!('tradeId' in plan.wanted));
  assert.deepEqual(plan.suggestions.map((s) => s.label), ['Trade: Plumbing']);
  const keep = planNewJobPrefill({ result: found(TRADE_ONLY, 'Gas and Water Piping'), form: form({ tradeId: '1', jobTypeId: '12' }), now, trades, technicians: [] });
  assert.deepEqual([keep.wanted.tradeId, keep.suggestions.length], [undefined, 0], 'Plumbing — Burst Pipe already chosen: nothing to change');
});

test('Calls & Contacts: suggestions only — full, Trade-only (with choices) and Call Back (no suggestion)', () => {
  const summary = (m, t, f = { tradeId: '', jobTypeId: '' }) => callLookupSummary(found(m, t), f, { trades, leadSources: [] }).jobType;
  assert.deepEqual(summary(FULL, 'Ongoing Servicing').suggestion, { tradeId: 3, jobTypeId: 31, label: 'Heating & Cooling — Servicing' });
  const piping = summary(TRADE_ONLY, 'Gas and Water Piping');
  assert.deepEqual([piping.kind, piping.suggestion, piping.choices.map((c) => c.name)], ['tradeOnly', { tradeId: 1, jobTypeId: '', label: 'Plumbing' }, ['Gas Fitting', 'Burst Pipe']]);
  assert.equal(summary(TRADE_ONLY, 'Gas and Water Piping', { tradeId: '1', jobTypeId: '11' }).alreadySet, true);
  const cb = summary(CALLBACK, 'Call Back');
  assert.deepEqual([cb.kind, cb.suggestion], ['callback', null]);
});
