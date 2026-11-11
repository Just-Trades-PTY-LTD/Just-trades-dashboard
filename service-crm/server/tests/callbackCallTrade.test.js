import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, run as dbRun } from '../src/db/index.js';
import { nextLookupFill } from '../../client/src/lib/lookupFill.js';
import { leadCallStatus } from '../../client/src/lib/leadCallStatus.js';

// Calls & Contacts "Call back" calls record the Trade / Job type of the
// callback work (the call type stays Call back), prefilled from the original
// CRM job when one is reliably known. Uses the calls table's existing
// trade_id / job_type_id — no migration.
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const electrical = b.trades.find((t) => t.name === 'Electrical');
  const powerPoints = electrical.jobTypes.find((j) => j.name === 'Power Points') || electrical.jobTypes[0];
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const reason = b.lists.callback_reason?.[0]?.id;
  const newJob = (jobNumber, visitDate, trade, jobType, extra = {}) =>
    server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate, technicianId: tech.id, jobNumber, tradeId: trade.id, jobTypeId: jobType.id,
      lead: 'Qualified', invoiceNumber: `INV-${jobNumber}`, invoiceDate: visitDate, saleValueExGst: 400, ...extra,
    });
  const callBackCall = (jobNumber, extra = {}) =>
    server.request('POST', '/calls', { callAt: '2026-05-05T09:00', direction: 'Inbound', callType: 'Call back', jobNumber, callBackReasonId: reason, ...extra });
  const origin = async (jn) => ok(await server.request('GET', `/lookup/callback-origin?jn=${encodeURIComponent(jn)}`));
  return { electrical, powerPoints, plumbing, tech, newJob, callBackCall, origin };
}

test('Call back call: no migration — the calls table already has trade_id and job_type_id', async () => {
  const server = await startTestServer();
  try {
    const cols = dbAll('PRAGMA table_info(calls)').map((c) => c.name);
    assert.ok(cols.includes('trade_id') && cols.includes('job_type_id'));
  } finally {
    server.close();
  }
});

test('original CRM job -> prefill source; saved and edited Trade / Job type are in Activity history', async () => {
  const server = await startTestServer();
  try {
    const { electrical, powerPoints, plumbing, newJob, callBackCall, origin } = await setup(server);
    ok(await newJob('E-100', '2026-05-01', electrical, powerPoints));
    const o = await origin('E-100');
    assert.deepEqual(
      { found: o.found, source: o.source, jn: o.originalJobNumber, tradeId: o.tradeId, jobTypeId: o.jobTypeId, trade: o.trade },
      { found: true, source: 'crmJob', jn: 'E-100', tradeId: electrical.id, jobTypeId: powerPoints.id, trade: 'Electrical' }
    );
    const call = ok(await callBackCall('E-100', { tradeId: o.tradeId, jobTypeId: o.jobTypeId }));
    assert.deepEqual([call.callType, call.tradeId, call.jobTypeId], ['Call back', electrical.id, powerPoints.id], 'call type stays Call back');
    let h = ok(await server.request('GET', `/calls/${call.id}/history`));
    assert.deepEqual([h[0].changes.trade_id.to, h[0].changes.job_type_id.to], [electrical.id, powerPoints.id]);
    // Editable: staff change it; the change is recorded.
    ok(await server.request('PATCH', `/calls/${call.id}`, { tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id }));
    h = ok(await server.request('GET', `/calls/${call.id}/history`));
    assert.deepEqual(h[0].changes.trade_id, { from: electrical.id, to: plumbing.id });
  } finally {
    server.close();
  }
});

test('Technician & Sales Call Back entry: the new callback JN uses the original job; conflicting entries and pre-CRM / unmatched JNs are left for staff', async () => {
  const server = await startTestServer();
  try {
    const { electrical, powerPoints, plumbing, tech, newJob, origin } = await setup(server);
    ok(await newJob('E-200', '2026-05-01', electrical, powerPoints));
    // The new callback JN is itself later logged as a New Job of another trade:
    // the Call Back entry's original job still wins.
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'E-200', newJobNumber: 'CB-200', visitDate: '2026-05-06', technicianId: tech.id, creditedTechnicianId: tech.id }));
    ok(await newJob('CB-200', '2026-05-06', plumbing, plumbing.jobTypes[0]));
    const o = await origin('CB-200');
    assert.deepEqual([o.source, o.originalJobNumber, o.tradeId, o.jobTypeId], ['callBackEntry', 'E-200', electrical.id, powerPoints.id]);

    // Two entries linking the same new JN to different originals: not guessed.
    ok(await newJob('E-201', '2026-05-01', plumbing, plumbing.jobTypes[0]));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'E-200', newJobNumber: 'CB-X', visitDate: '2026-05-06', technicianId: tech.id, creditedTechnicianId: tech.id }));
    // (The form refuses reusing a new callback JN; this can only exist in older data.)
    dbRun("INSERT INTO call_backs (job_number, new_job_number, visit_date, attending_technician_id, credited_technician_id) VALUES ('E-201', 'CB-X', '2026-05-07', ?, ?)", [tech.id, tech.id]);
    assert.deepEqual([(await origin('CB-X')).found, (await origin('CB-X')).source], [false, 'conflict']);

    // Pre-CRM original job (not in the CRM) and a JN with no match at all.
    assert.deepEqual(await origin('1999'), { found: false, source: null });
    assert.deepEqual(await origin('NO-MATCH'), { found: false, source: null });
  } finally {
    server.close();
  }
});

test('call form fill: blank fields only, follows the Job Number, never overrides a staff choice', () => {
  const r = { tradeId: 2, jobTypeId: 21 };
  let { patch, filled } = nextLookupFill({ tradeId: '', jobTypeId: '' }, {}, r);
  assert.deepEqual(patch, { tradeId: 2, jobTypeId: 21 });
  // A different JN with no original job takes back what was filled (unchanged).
  assert.deepEqual(nextLookupFill({ tradeId: 2, jobTypeId: 21 }, filled, {}).patch, { tradeId: '', jobTypeId: '' });
  // Staff changed the job type: that's kept.
  assert.deepEqual(nextLookupFill({ tradeId: 2, jobTypeId: 25 }, filled, {}).patch, { tradeId: '' });
  ({ patch } = nextLookupFill({ tradeId: 5, jobTypeId: 51 }, {}, r));
  assert.deepEqual(patch, {}, 'a staff choice is never replaced');
});

test('sale made from the callback JN: New Job prefills Trade / Job type from the Call back call, stays a New Job, reports Repeat customer under its Trade', async () => {
  const server = await startTestServer();
  try {
    const { electrical, powerPoints, plumbing, newJob, callBackCall } = await setup(server);
    // Pre-CRM original: staff choose Electrical — Power Points on the call.
    ok(await callBackCall('CB-300', { tradeId: electrical.id, jobTypeId: powerPoints.id, suburb: 'Kilburn (5084)' }));
    const look = ok(await server.request('GET', '/lookup/call?jn=CB-300'));
    assert.deepEqual([look.callType, look.tradeId, look.jobTypeId, look.suburb], ['Call back', electrical.id, powerPoints.id, 'Kilburn (5084)'], 'New Job form prefill source');
    assert.equal(look.callback.kind, 'callbackCall');
    assert.match(leadCallStatus('CB-300', look, '2026-05-08').text, /Repeat customer/);

    const job = ok(await newJob('CB-300', '2026-05-08', electrical, powerPoints)).entry;
    assert.equal(job.kind, 'new_job_sale_made', 'remains New Job — Sale Made');
    // Staff can choose a different Trade for different work sold (another callback JN).
    ok(await callBackCall('CB-301', { tradeId: electrical.id, jobTypeId: powerPoints.id }));
    ok(await newJob('CB-301', '2026-05-09', plumbing, plumbing.jobTypes[0]));

    const rep = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    const repeat = rep.salesByMarketingCategory.rows.find((r) => r.category === 'Repeat customer');
    assert.deepEqual([repeat.sales, repeat.totalSalesValueExGst], [2, 800], 'both callback sales: Repeat customer');
    const elecOnly = ok(await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&tradeId=${electrical.id}&jobTypeId=${powerPoints.id}`));
    assert.deepEqual(elecOnly.salesByMarketingCategory.rows.map((r) => [r.category, r.sales]), [['Repeat customer', 1]], 'Electrical — Power Points, Repeat customer');
  } finally {
    server.close();
  }
});
