import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Job Type filter on the Calls & Contacts report. Must satisfy, in full:
//   - narrows company KPIs, both trade breakdowns (Calls by Trade / Leads by
//     Trade) and click-through drill-downs, the same way the existing
//     Trade/Staff filters already do
//   - works alongside Trade/Staff/date filters, not instead of them
//   - a job type belongs to exactly one trade, so filtering by job type
//     naturally narrows to that trade's own records too
//   - this is a reporting/filtering change only — the calls.job_type_id
//     column already existed (Contact History's own Advanced Filters already
//     used it) and no record is ever altered by reading these figures

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const hotWaterUnit = plumbing.jobTypes.find((jt) => jt.name === 'Hot water unit');
  const blockedDrain = plumbing.jobTypes.find((jt) => jt.name === 'Blocked drain');
  const staffDirectory = (await server.request('GET', '/users/directory')).data;
  const admin = staffDirectory[0];
  return { plumbing, hotWaterUnit, blockedDrain, admin };
}

test('the Job Type filter narrows Calls report KPIs and both trade breakdowns, alongside the existing Trade filter', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, blockedDrain, admin } = await setup(server);

    // Two Hot water unit calls (one Lead, one Not lead) and one Blocked
    // drain Lead — all same trade/staff/date range, differing only by job type.
    await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    await server.request('POST', '/calls', {
      callAt: '2026-05-02T09:00:00',
      direction: 'Inbound',
      callType: 'Not lead',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      handledByUserId: admin.id,
    });
    await server.request('POST', '/calls', {
      callAt: '2026-05-03T09:00:00',
      direction: 'Outbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobTypeId: blockedDrain.id,
      handledByUserId: admin.id,
      booked: 'No',
    });

    const unfiltered = (
      await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&tradeId=${plumbing.id}`)
    ).data;
    assert.equal(unfiltered.kpis.total, 3, 'unfiltered (Trade only) sees all three calls');

    const filtered = (
      await server.request(
        'GET',
        `/reports/calls?from=2026-05-01&to=2026-05-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`
      )
    ).data;
    assert.equal(filtered.kpis.total, 2, 'Job Type filter narrows Total Contacts to only the Hot water unit calls');
    assert.equal(filtered.kpis.leadsCount, 1, 'Leads narrowed to the one Hot water unit lead');

    const byTradeRow = filtered.byTrade.find((r) => r.name === 'Plumbing');
    assert.equal(byTradeRow.value, 2, 'Calls by Trade narrowed to the Hot water unit calls only');
    const leadsByTradeRow = filtered.leadsByTrade.find((r) => r.name === 'Plumbing');
    assert.equal(leadsByTradeRow.value, 1, 'Leads by Trade narrowed to the one Hot water unit lead');
  } finally {
    server.close();
  }
});

test('the Job Type drill-down returns exactly the matching call records, respecting every other applied filter', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, blockedDrain, admin } = await setup(server);

    const hwuCall = await server.request('POST', '/calls', {
      callAt: '2026-06-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    const bdCall = await server.request('POST', '/calls', {
      callAt: '2026-06-02T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobTypeId: blockedDrain.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    assert.equal(hwuCall.status, 201);
    assert.equal(bdCall.status, 201);

    const drill = (
      await server.request(
        'GET',
        `/reports/calls/drilldown?from=2026-06-01&to=2026-06-30&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}&metric=total`
      )
    ).data;
    assert.equal(drill.count, 1, 'drill-down for Total Contacts, scoped to Hot water unit, returns exactly one record');
    assert.equal(drill.rows[0].id, hwuCall.data.id);
    assert.ok(!drill.rows.some((r) => r.id === bdCall.data.id), 'the Blocked drain call is never included');

    const leadsDrill = (
      await server.request(
        'GET',
        `/reports/calls/drilldown?from=2026-06-01&to=2026-06-30&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}&metric=leadsByTrade&category=Plumbing`
      )
    ).data;
    assert.equal(leadsDrill.count, 1, 'Leads by Trade drill-down (Hot water unit) returns exactly the one matching lead');
    assert.equal(leadsDrill.rows[0].id, hwuCall.data.id);
  } finally {
    server.close();
  }
});

test('reading the Calls report with a Job Type filter applied never alters any call record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, admin } = await setup(server);
    const created = await server.request('POST', '/calls', {
      callAt: '2026-07-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      handledByUserId: admin.id,
      booked: 'Yes',
      notes: 'original notes',
    });
    assert.equal(created.status, 201);

    await server.request('GET', `/reports/calls?from=2026-07-01&to=2026-07-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`);
    await server.request(
      'GET',
      `/reports/calls/drilldown?from=2026-07-01&to=2026-07-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}&metric=total`
    );
    await server.request('GET', `/reports/calls.xlsx?from=2026-07-01&to=2026-07-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`);

    const stillThere = (await server.request('GET', '/calls')).data.find((c) => c.id === created.data.id);
    assert.ok(stillThere, 'the call record is untouched after being read through every Job-Type-filtered endpoint');
    assert.equal(stillThere.notes, 'original notes');
    assert.equal(stillThere.jobTypeId, hotWaterUnit.id);
  } finally {
    server.close();
  }
});
