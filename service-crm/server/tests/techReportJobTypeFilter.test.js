import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Job Type filter on the Technician & Sales report. Must satisfy, in full:
//   - narrows company-level KPIs, By Trade, By Technician, charts and
//     drill-downs consistently, same as the existing Trade/Technician filters
//   - works alongside Trade/Technician/date filters, not instead of them
//   - a job type belongs to exactly one trade, so filtering by job type
//     naturally narrows to that trade's own records too
//   - pending_cancellations has no job_type_id column at all — selecting a
//     specific Job Type must correctly show 0 pending cancellations rather
//     than guess/attribute one to a job type it was never recorded against
//   - purely a reporting/filtering change: no job/sale/call-back/pending-
//     cancellation record is ever altered by reading these figures

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const hotWaterUnit = plumbing.jobTypes.find((jt) => jt.name === 'Hot water unit');
  const blockedDrain = plumbing.jobTypes.find((jt) => jt.name === 'Blocked drain');
  const tech = (await server.request('POST', '/settings/technicians', { name: 'Job Type Filter Tech' })).data;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  return { plumbing, hotWaterUnit, blockedDrain, tech, knockbackReasonId };
}

test('the Job Type filter narrows company KPIs, By Trade and By Technician consistently, alongside Trade/Technician/date filters', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, blockedDrain, tech, knockbackReasonId } = await setup(server);

    // Two Hot water unit jobs (one sale made, one knock-back) and one
    // Blocked drain job — all same trade/technician/date range, differing
    // only by job type.
    const saleJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-09-01',
      technicianId: tech.id,
      jobNumber: 'JTF-HWU-SALE-1',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-JTF-HWU-SALE-1',
      invoiceDate: '2026-09-01',
      saleValueExGst: 500,
    });
    const knockbackJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-02',
      technicianId: tech.id,
      jobNumber: 'JTF-HWU-KB-1',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      lead: 'Qualified',
      knockbackReasonId,
    });
    const otherTypeJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-09-03',
      technicianId: tech.id,
      jobNumber: 'JTF-BD-SALE-1',
      tradeId: plumbing.id,
      jobTypeId: blockedDrain.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-JTF-BD-SALE-1',
      invoiceDate: '2026-09-03',
      saleValueExGst: 300,
    });
    assert.equal(saleJob.status, 201);
    assert.equal(knockbackJob.status, 201);
    assert.equal(otherTypeJob.status, 201);

    const unfiltered = (
      await server.request('GET', `/reports/tech?from=2026-09-01&to=2026-09-30&technicianId=${tech.id}&tradeId=${plumbing.id}`)
    ).data;
    assert.equal(unfiltered.company.jobsAttended, 3, 'unfiltered (Trade only) sees all three jobs');

    const filtered = (
      await server.request(
        'GET',
        `/reports/tech?from=2026-09-01&to=2026-09-30&technicianId=${tech.id}&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`
      )
    ).data;
    assert.equal(filtered.company.jobsAttended, 2, 'Job Type filter narrows Total Jobs to only the Hot water unit jobs');
    assert.equal(filtered.company.sales, 1, 'Sales narrowed to the one Hot water unit sale');
    assert.equal(filtered.company.knockbacks, 1, 'Knock-backs narrowed to the one Hot water unit knock-back');

    const plumbingRow = filtered.byTrade.find((r) => r.trade === 'Plumbing');
    assert.equal(plumbingRow.jobsAttended, 2, 'By Trade: Plumbing row also narrowed to the Hot water unit jobs only');

    const techRow = filtered.byTechnician.find((r) => r.name === tech.name);
    assert.equal(techRow.jobsAttended, 2, 'By Technician: row narrowed to the Hot water unit jobs only');
  } finally {
    server.close();
  }
});

test('the Job Type drill-down returns exactly the matching job records, respecting every other applied filter', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, blockedDrain, tech } = await setup(server);

    const hwuJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-10-01',
      technicianId: tech.id,
      jobNumber: 'JTF-DRILL-HWU-1',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-JTF-DRILL-HWU-1',
      invoiceDate: '2026-10-01',
      saleValueExGst: 400,
    });
    const bdJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-10-02',
      technicianId: tech.id,
      jobNumber: 'JTF-DRILL-BD-1',
      tradeId: plumbing.id,
      jobTypeId: blockedDrain.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-JTF-DRILL-BD-1',
      invoiceDate: '2026-10-02',
      saleValueExGst: 250,
    });
    assert.equal(hwuJob.status, 201);
    assert.equal(bdJob.status, 201);

    const drill = (
      await server.request(
        'GET',
        `/reports/tech/drilldown?from=2026-10-01&to=2026-10-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}&metric=jobsAttended`
      )
    ).data;
    assert.equal(drill.count, 1, 'drill-down for Total Jobs, scoped to Hot water unit, returns exactly one record');
    assert.equal(drill.rows[0].id, hwuJob.data.entry.id);
    assert.ok(!drill.rows.some((r) => r.id === bdJob.data.entry.id), 'the Blocked drain job is never included');
  } finally {
    server.close();
  }
});

test('with a specific Job Type selected, Pending Cancellations correctly show as 0 rather than being guessed at (the table has no job_type_id)', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, tech } = await setup(server);

    // A Sale Made job (Hot water unit) that is then marked Pending Cancellation.
    const saleJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-11-01',
      technicianId: tech.id,
      jobNumber: 'JTF-PC-1',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-JTF-PC-1',
      invoiceDate: '2026-11-01',
      saleValueExGst: 600,
    });
    assert.equal(saleJob.status, 201);
    const pendingCancel = await server.request('POST', '/tech/pending-cancellations', {
      jobNumber: 'JTF-PC-1',
      dateLogged: '2026-11-05',
      creditedTechnicianId: tech.id,
      tradeId: plumbing.id,
    });
    assert.equal(pendingCancel.status, 201, JSON.stringify(pendingCancel.data));

    const unfiltered = (
      await server.request('GET', `/reports/tech?from=2026-11-01&to=2026-11-30&tradeId=${plumbing.id}`)
    ).data;
    assert.equal(unfiltered.company.pendingCancellations, 1, 'without a Job Type filter, the pending cancellation is counted as before');

    const filtered = (
      await server.request(
        'GET',
        `/reports/tech?from=2026-11-01&to=2026-11-30&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`
      )
    ).data;
    assert.equal(
      filtered.company.pendingCancellations,
      0,
      'with a Job Type filter applied, Pending Cancellations correctly shows 0 — never incorrectly attributed to a job type'
    );
    // Every other figure for this same scope stays correct.
    assert.equal(filtered.company.jobsAttended, 1);
    assert.equal(filtered.company.sales, 1);
  } finally {
    server.close();
  }
});

test('reading the Technician & Sales report with a Job Type filter applied never alters any job, sale or pending-cancellation record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, hotWaterUnit, tech, knockbackReasonId } = await setup(server);
    const job = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-12-01',
      technicianId: tech.id,
      jobNumber: 'JTF-SAFE-1',
      tradeId: plumbing.id,
      jobTypeId: hotWaterUnit.id,
      lead: 'Qualified',
      knockbackReasonId,
    });
    assert.equal(job.status, 201);

    await server.request('GET', `/reports/tech?from=2026-12-01&to=2026-12-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`);
    await server.request(
      'GET',
      `/reports/tech/drilldown?from=2026-12-01&to=2026-12-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}&metric=knockbacks`
    );
    await server.request('GET', `/reports/tech.xlsx?from=2026-12-01&to=2026-12-31&tradeId=${plumbing.id}&jobTypeId=${hotWaterUnit.id}`);

    const stillThere = (await server.request('GET', '/tech/entries')).data.find((e) => e.id === job.data.entry.id && e.kind === 'new_job_no_sale');
    assert.ok(stillThere, 'the job record is untouched after being read through every Job-Type-filtered endpoint');
    assert.equal(stillThere.jobTypeId, hotWaterUnit.id);
    assert.equal(stillThere.knockback, true);
  } finally {
    server.close();
  }
});
