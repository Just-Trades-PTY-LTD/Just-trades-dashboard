import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('duplicate invoice numbers are only counted once in reports', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const first = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2025-04-01',
      technicianId: tech.id,
      jobNumber: 'JN-1',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-1',
      invoiceDate: '2025-04-01',
      saleValueExGst: 500,
    });
    assert.equal(first.data.notice, null);

    const second = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2025-04-02',
      technicianId: tech.id,
      jobNumber: 'JN-2',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-1', // same invoice number, entered again by mistake
      invoiceDate: '2025-04-02',
      saleValueExGst: 999,
    });
    assert.ok(second.data.notice, 'duplicate invoice should trigger a warning, not a hard block');

    // Both jobs still show up as separate visits (jobs attended is never
    // deduplicated), but the sale total only counts the invoice once.
    const report = (await server.request('GET', '/reports/tech?from=2025-04-01&to=2025-04-30')).data;
    assert.equal(report.company.jobsAttended, 2, 'both visits still count');
    assert.equal(report.company.sales, 1, 'duplicate invoice counted once');
    assert.equal(report.company.totalSaleExGst, 999, 'keeps the most recently logged copy of the duplicate');
  } finally {
    server.close();
  }
});

test('Call Back never counts as a job, lead, or sale', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2025-05-01',
      technicianId: tech.id,
      jobNumber: 'JN-500',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-500',
      invoiceDate: '2025-05-01',
      saleValueExGst: 200,
    });

    await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-500',
      visitDate: '2025-05-10',
      technicianId: tech.id,
      creditedTechnicianId: tech.id,
      reasonId: bundle.lists.callback_reason[0]?.id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2025-05-01&to=2025-05-31')).data;
    assert.equal(report.company.jobsAttended, 1, 'the call back visit is not a job');
    assert.equal(report.company.sales, 1, 'the call back does not create a second sale');
    assert.equal(report.company.callBacks, 1);
  } finally {
    server.close();
  }
});

test('Pending Cancellation does not change sale figures (flag-only)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2025-06-01',
      technicianId: tech.id,
      jobNumber: 'JN-600',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-600',
      invoiceDate: '2025-06-01',
      saleValueExGst: 300,
    });

    await server.request('POST', '/tech/pending-cancellations', {
      jobNumber: 'JN-600',
      dateLogged: '2025-06-15',
      creditedTechnicianId: tech.id,
      reasonId: bundle.lists.pending_cancellation_reason[0]?.id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2025-06-01&to=2025-06-30')).data;
    assert.equal(report.company.sales, 1);
    assert.equal(report.company.totalSaleExGst, 300, 'sale value is untouched by the pending cancellation');
    assert.equal(report.company.pendingCancellations, 1, 'tracked separately');
  } finally {
    server.close();
  }
});
