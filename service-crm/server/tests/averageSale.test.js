import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Average sale = Total Sales Value (ex GST) ÷ Qualified Jobs — not the
// number of sales, and not every job attended (unqualified jobs must not
// affect it at all).
test('average sale divides Total Sales Value by Qualified Jobs only, and unqualified jobs never affect it', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Cody' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // 5 qualified knock-backs (no sale) + 2 qualified sales, matching the
    // shape of the reported discrepancy: total sale value should be divided
    // by 7 qualified jobs, not 2 sales.
    for (let i = 0; i < 5; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-05-01',
        technicianId: tech.id,
        jobNumber: `JN-AVG-KB-${i}`,
        tradeId: plumbing.id,
        lead: 'Qualified',
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      });
    }
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-02',
      technicianId: tech.id,
      jobNumber: 'JN-AVG-S1',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-AVG-1',
      invoiceDate: '2026-05-02',
      saleValueExGst: 2000,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-03',
      technicianId: tech.id,
      jobNumber: 'JN-AVG-S2',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-AVG-2',
      invoiceDate: '2026-05-03',
      saleValueExGst: 1752,
    });

    // 3 unqualified, no-sale jobs — these must be counted in Total Jobs but
    // must not move the qualified-jobs denominator or average sale at all.
    for (let i = 0; i < 3; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-05-04',
        technicianId: tech.id,
        jobNumber: `JN-AVG-UNQ-${i}`,
        tradeId: plumbing.id,
        lead: 'Not Qualified',
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      });
    }

    const report = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const techRow = report.byTechnician.find((r) => r.name === 'Cody');

    assert.equal(techRow.jobsAttended, 10, 'all 10 visits count as Total Jobs, qualified and unqualified alike');
    assert.equal(techRow.qualifiedJobs, 7, 'only the 7 Qualified visits count as Qualified Jobs');
    assert.equal(techRow.unqualifiedJobs, 3);
    assert.equal(techRow.sales, 2, 'only the 2 qualified visits produced a sale');
    assert.equal(techRow.knockbacks, 5, 'the 3 unqualified no-sale visits are never counted as knock-backs, only the 5 qualified ones');
    // Average sale must ignore the 3 unqualified jobs' presence entirely, so
    // it's still exactly 3752 / 7, not 3752 / 10.
    assert.equal(techRow.avgSaleExGst, 536, '3752 / 7 qualified jobs = 536 exactly, unaffected by the unqualified jobs');
  } finally {
    server.close();
  }
});

test('average sale keeps cents rather than rounding at the source (server returns full precision)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Tylor' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // 4 qualified knock-backs + 2 qualified sales totalling $1,631 across 6
    // qualified jobs — doesn't divide evenly, so this is the case that would
    // expose rounding done too early.
    for (let i = 0; i < 4; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-06-01',
        technicianId: tech.id,
        jobNumber: `JN-AVG2-KB-${i}`,
        tradeId: plumbing.id,
        lead: 'Qualified',
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      });
    }
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-06-02',
      technicianId: tech.id,
      jobNumber: 'JN-AVG2-S1',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-AVG2-1',
      invoiceDate: '2026-06-02',
      saleValueExGst: 831,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-06-03',
      technicianId: tech.id,
      jobNumber: 'JN-AVG2-S2',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-AVG2-2',
      invoiceDate: '2026-06-03',
      saleValueExGst: 800,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30')).data;
    const techRow = report.byTechnician.find((r) => r.name === 'Tylor');

    assert.equal(techRow.jobsAttended, 6);
    assert.equal(techRow.qualifiedJobs, 6);
    assert.equal(techRow.totalSaleExGst, 1631);
    // 1631 / 6 = 271.8333... — must not have been rounded to 272 server-side.
    assert.ok(Math.abs(techRow.avgSaleExGst - 271.8333333333333) < 0.0001);
  } finally {
    server.close();
  }
});

test('average sale is $0, not an error, when there are no jobs at all', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const report = (await server.request('GET', '/reports/tech?from=2026-01-01&to=2026-01-31')).data;
    assert.equal(report.company.jobsAttended, 0);
    assert.equal(report.company.avgSaleExGst, 0);
  } finally {
    server.close();
  }
});

test('average sale is $0, not an error, when every job attended is unqualified (zero qualified jobs)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-07-01',
      jobNumber: 'JN-AVG3-UNQ-1',
      tradeId: plumbing.id,
      lead: 'Not Qualified',
      invoiceNumber: 'INV-AVG3-1',
      invoiceDate: '2026-07-01',
      saleValueExGst: 500,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;
    assert.equal(report.company.jobsAttended, 1);
    assert.equal(report.company.qualifiedJobs, 0);
    assert.equal(report.company.unqualifiedJobs, 1);
    assert.equal(report.company.avgSaleExGst, 0, 'zero qualified jobs must yield $0, not a division error');
  } finally {
    server.close();
  }
});
