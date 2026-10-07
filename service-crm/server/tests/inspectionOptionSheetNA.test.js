import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Inspection sheet / option sheet are plain text columns with no allowed-value
// constraint — adding "N/A" as a UI option needed no schema change, and any
// value the client sends round-trips through untouched.
test('inspection sheet and option sheet accept and save "N/A", not just Yes/No', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-01',
      technicianId: tech.id,
      jobNumber: 'JN-NA-1',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      inspectionSheet: 'N/A',
      optionSheet: 'N/A',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.entry.inspectionSheet, 'N/A');
    assert.equal(created.data.entry.optionSheet, 'N/A');

    // And it's editable back to Yes/No afterwards too, same as always.
    const patched = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, {
      inspectionSheet: 'Yes',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.inspectionSheet, 'Yes');
    assert.equal(patched.data.optionSheet, 'N/A', 'unrelated field left untouched by the patch');
  } finally {
    server.close();
  }
});

test('a job marked N/A on inspection/option sheet is excluded from the completion rate entirely (never counted as No)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-05',
      technicianId: tech.id,
      jobNumber: 'JN-NA-2',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      inspectionSheet: 'N/A',
      optionSheet: 'Yes',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;
    // N/A means "not applicable to this job" — it must be excluded from both
    // the numerator and the denominator, not silently treated as a No. The
    // only job in range this period has inspectionSheet='N/A', so there are
    // no Yes/No records at all behind that figure — the rate is null ("—"),
    // never 0%. Option sheet has one Yes and no No/N/A, so it's 100%.
    assert.equal(report.company.inspectionRate, null);
    assert.equal(report.company.optionRate, 100);
  } finally {
    server.close();
  }
});

// Percentage = Yes ÷ (Yes + No) × 100, with N/A excluded from both sides —
// covers every example from the reported bug, at the company level (which
// also exercises By Trade and By Technician, since computeMetrics() is the
// one shared function behind all three — see services/reports.js).
test('Inspection Sheet / Option Sheet completion rate: mixed Yes/No/N/A and all-N/A', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Priya' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const knockbackReasonId = bundle.lists.knockback_reason[0].id;

    // 4 Yes, 1 No, 3 N/A on Inspection Sheet => 80%.
    // Option Sheet on the same 8 jobs: 4 Yes, 0 No, 4 N/A => 100%.
    const inspectionValues = ['Yes', 'Yes', 'Yes', 'Yes', 'No', 'N/A', 'N/A', 'N/A'];
    const optionValues = ['Yes', 'Yes', 'Yes', 'Yes', 'N/A', 'N/A', 'N/A', 'N/A'];
    for (let i = 0; i < inspectionValues.length; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-08-01',
        technicianId: tech.id,
        jobNumber: `JN-MIX-${i}`,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified',
        inspectionSheet: inspectionValues[i],
        optionSheet: optionValues[i],
        knockbackReasonId,
      });
    }

    const report = (await server.request('GET', '/reports/tech?from=2026-08-01&to=2026-08-31')).data;
    assert.equal(report.company.inspectionRate, 80);
    assert.equal(report.company.optionRate, 100);

    // The same shared computeMetrics() function drives By Trade and By
    // Technician, so both must show the exact same figures as Company —
    // never a separately-calculated (and possibly diverging) number.
    const plumbingRow = report.byTrade.find((r) => r.trade === 'Plumbing');
    assert.equal(plumbingRow.inspectionRate, 80);
    assert.equal(plumbingRow.optionRate, 100);
    const priyaRow = report.byTechnician.find((r) => r.name === 'Priya');
    assert.equal(priyaRow.inspectionRate, 80);
    assert.equal(priyaRow.optionRate, 100);

    // 0 Yes, 2 No, 3 N/A => 0% — distinct from "all N/A" below, never
    // confused with it even though both involve N/A records.
    const zeroYesTech = (await server.request('POST', '/settings/technicians', { name: 'ZeroYes' })).data;
    for (let i = 0; i < 2; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-08-02',
        technicianId: zeroYesTech.id,
        jobNumber: `JN-NO-${i}`,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified',
        inspectionSheet: 'No',
        knockbackReasonId,
      });
    }
    for (let i = 0; i < 3; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-08-02',
        technicianId: zeroYesTech.id,
        jobNumber: `JN-NO-NA-${i}`,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified',
        inspectionSheet: 'N/A',
        knockbackReasonId,
      });
    }
    const zeroYesReport = (await server.request('GET', '/reports/tech?from=2026-08-02&to=2026-08-02&technicianId=' + zeroYesTech.id)).data;
    assert.equal(zeroYesReport.company.inspectionRate, 0);

    // 0 Yes, 0 No, 5 N/A => null ("—" on screen/export), never 0% — an
    // all-N/A result must never read as "0% completed", which would imply
    // the technician failed to complete something that was never applicable.
    const allNaTech = (await server.request('POST', '/settings/technicians', { name: 'AllNA' })).data;
    for (let i = 0; i < 5; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-08-03',
        technicianId: allNaTech.id,
        jobNumber: `JN-ALLNA-${i}`,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified',
        inspectionSheet: 'N/A',
        optionSheet: 'N/A',
        knockbackReasonId,
      });
    }
    const allNaReport = (
      await server.request('GET', '/reports/tech?from=2026-08-03&to=2026-08-03&technicianId=' + allNaTech.id)
    ).data;
    assert.equal(allNaReport.company.inspectionRate, null);
    assert.equal(allNaReport.company.optionRate, null);
    const allNaTechRow = allNaReport.byTechnician.find((r) => r.name === 'AllNA');
    assert.equal(allNaTechRow.inspectionRate, null);
    assert.equal(allNaTechRow.optionRate, null);
  } finally {
    server.close();
  }
});

// The drill-down behind the Inspection/Option Sheet % figure must show only
// the Yes/No records the percentage was actually calculated from — an N/A
// row must never appear in that list looking like a hidden "non-completion".
test('Inspection Sheet % drill-down excludes N/A records from its row list and outcomes', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Drill' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const knockbackReasonId = bundle.lists.knockback_reason[0].id;

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-01',
      technicianId: tech.id,
      jobNumber: 'JN-D-YES',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      inspectionSheet: 'Yes',
      knockbackReasonId,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-02',
      technicianId: tech.id,
      jobNumber: 'JN-D-NO',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      inspectionSheet: 'No',
      knockbackReasonId,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-03',
      technicianId: tech.id,
      jobNumber: 'JN-D-NA',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      inspectionSheet: 'N/A',
      knockbackReasonId,
    });

    const drill = (
      await server.request('GET', '/reports/tech/drilldown?from=2026-09-01&to=2026-09-30&metric=inspectionRate')
    ).data;
    assert.equal(drill.rows.length, 2, 'only the Yes and No jobs — the N/A job must not appear');
    const jns = drill.rows.map((r) => r.jobNumber).sort();
    assert.deepEqual(jns, ['JN-D-NO', 'JN-D-YES']);
    assert.deepEqual(
      drill.outcomes.map((o) => o.label),
      ['Yes', 'No'],
      'no "No / not recorded" bucket — N/A is excluded, not lumped in with No'
    );
    assert.equal(drill.outcomes.find((o) => o.label === 'Yes').count, 1);
    assert.equal(drill.outcomes.find((o) => o.label === 'No').count, 1);
  } finally {
    server.close();
  }
});
