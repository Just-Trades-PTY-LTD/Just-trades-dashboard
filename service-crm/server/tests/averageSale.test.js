import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Average sale must divide total sale value by every job attended, including
// knockbacks — not by the number of sales — since it's meant as a
// productivity figure, not an average invoice size.
test('average sale divides by every job attended, including knock-backs, not just sales', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Cody' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // 5 knock-backs (no sale) + 2 sales, matching the shape of the reported
    // discrepancy: total sale value should be divided by 7 jobs, not 2 sales.
    for (let i = 0; i < 5; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-05-01',
        technicianId: tech.id,
        jobNumber: `JN-AVG-KB-${i}`,
        tradeId: plumbing.id,
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      });
    }
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-02',
      technicianId: tech.id,
      jobNumber: 'JN-AVG-S1',
      tradeId: plumbing.id,
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
      invoiceNumber: 'INV-AVG-2',
      invoiceDate: '2026-05-03',
      saleValueExGst: 1752,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const techRow = report.byTechnician.find((r) => r.name === 'Cody');

    assert.equal(techRow.jobsAttended, 7, 'all 7 visits count as jobs attended');
    assert.equal(techRow.sales, 2, 'only 2 of those visits produced a sale');
    assert.equal(techRow.totalSaleExGst, 3752);
    // 3752 / 7 jobs = 536 exactly, NOT 3752 / 2 sales = 1876.
    assert.equal(techRow.avgSaleExGst, 536);
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

    // 4 knock-backs + 2 sales totalling $1,631 across 6 jobs — doesn't divide
    // evenly, so this is the case that would expose rounding done too early.
    for (let i = 0; i < 4; i++) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-06-01',
        technicianId: tech.id,
        jobNumber: `JN-AVG2-KB-${i}`,
        tradeId: plumbing.id,
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      });
    }
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-06-02',
      technicianId: tech.id,
      jobNumber: 'JN-AVG2-S1',
      tradeId: plumbing.id,
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
      invoiceNumber: 'INV-AVG2-2',
      invoiceDate: '2026-06-03',
      saleValueExGst: 800,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30')).data;
    const techRow = report.byTechnician.find((r) => r.name === 'Tylor');

    assert.equal(techRow.jobsAttended, 6);
    assert.equal(techRow.totalSaleExGst, 1631);
    // 1631 / 6 = 271.8333... — must not have been rounded to 272 server-side.
    assert.ok(Math.abs(techRow.avgSaleExGst - 271.8333333333333) < 0.0001);
  } finally {
    server.close();
  }
});

test('average sale is 0, not an error, when there are no jobs at all', async () => {
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
