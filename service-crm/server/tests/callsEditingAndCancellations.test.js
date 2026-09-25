import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('editing a call with cleared optional fields no longer 500s', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/calls', {
      callAt: '2026-01-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      leadSourceId: bundle.lists.lead_source[0].id,
      booked: 'Yes',
    });
    assert.equal(created.status, 201);

    // This is exactly what the UI sends when a Select is reset to its blank
    // placeholder option — value "" for every optional FK field at once.
    const patched = await server.request('PATCH', `/calls/${created.data.id}`, {
      tradeId: '',
      jobTypeId: '',
      leadSourceId: '',
      handledByUserId: '',
      notBookedReasonId: '',
      cancellationReasonId: '',
      callBackReasonId: '',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.tradeId, null);
    assert.equal(patched.data.leadSourceId, null);
  } finally {
    server.close();
  }
});

test('editing a Tech & Sales job entry with cleared optional fields no longer 500s', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-01-01',
      technicianId: tech.id,
      jobNumber: 'JN-EDIT-1',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    assert.equal(created.status, 201);

    const patched = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, {
      technicianId: '',
      tradeId: '',
      jobTypeId: '',
      knockbackReasonId: '',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.technicianId, null);
    assert.equal(patched.data.tradeId, null);
  } finally {
    server.close();
  }
});

test('Pending Cancellation is logged through Calls, links to the existing sale, creates no new job or sale', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // Technician attended and sold work.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-02-01',
      technicianId: tech.id,
      jobNumber: 'JN-PC-1',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      invoiceNumber: 'INV-PC-1',
      invoiceDate: '2026-02-01',
      saleValueExGst: 500,
    });

    const jobOrSaleKinds = ['new_job_no_sale', 'new_job_sale_made', 'quote_approved_later'];
    const jobsBefore = (await server.request('GET', '/tech/entries?includeArchived=true')).data;
    assert.equal(jobsBefore.filter((e) => jobOrSaleKinds.includes(e.kind)).length, 1, 'only the one job/sale exists so far');

    // Customer cancels before the return visit — logged via Calls.
    const call = await server.request('POST', '/calls', {
      callAt: '2026-02-05T09:00',
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'Pending Cancellation',
      cancellationReasonId: bundle.lists.pending_cancellation_reason[0].id,
      jobNumber: 'JN-PC-1',
    });
    assert.equal(call.status, 201);

    // No new job or sale was created — only a pending_cancellation entry
    // appears alongside the original job/sale in the unified Job History feed.
    const jobsAfter = (await server.request('GET', '/tech/entries?includeArchived=true')).data;
    assert.equal(jobsAfter.filter((e) => jobOrSaleKinds.includes(e.kind)).length, 1, 'still only the original job/sale — no new job or sale created');
    assert.equal(jobsAfter.filter((e) => e.kind === 'pending_cancellation').length, 1, 'the pending cancellation now shows in Job History too');

    // But it shows up as a pending cancellation, linked to the right technician/trade.
    const report = (await server.request('GET', '/reports/tech?from=2026-02-01&to=2026-02-28')).data;
    assert.equal(report.company.pendingCancellations, 1);
    const techRow = report.byTechnician.find((r) => r.name === 'Sam Tech');
    assert.equal(techRow.pendingCancellations, 1);

    // Editing the call away from Pending Cancellation removes the link.
    const patched = await server.request('PATCH', `/calls/${call.data.id}`, { cancellationType: 'New Job Cancellation' });
    assert.equal(patched.status, 200);
    const reportAfter = (await server.request('GET', '/reports/tech?from=2026-02-01&to=2026-02-28')).data;
    assert.equal(reportAfter.company.pendingCancellations, 0, 'no longer counted once the call is no longer a Pending Cancellation');
  } finally {
    server.close();
  }
});

test('deleting a Pending Cancellation call removes its linked pending_cancellations record', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-03-01',
      technicianId: tech.id,
      jobNumber: 'JN-PC-2',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      invoiceNumber: 'INV-PC-2',
      invoiceDate: '2026-03-01',
      saleValueExGst: 300,
    });

    const call = await server.request('POST', '/calls', {
      callAt: '2026-03-05T09:00',
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'Pending Cancellation',
      jobNumber: 'JN-PC-2',
    });

    let report = (await server.request('GET', '/reports/tech?from=2026-03-01&to=2026-03-31')).data;
    assert.equal(report.company.pendingCancellations, 1);

    await server.request('DELETE', `/calls/${call.data.id}`);

    report = (await server.request('GET', '/reports/tech?from=2026-03-01&to=2026-03-31')).data;
    assert.equal(report.company.pendingCancellations, 0);
  } finally {
    server.close();
  }
});

test('New Job Cancellation never creates a pending_cancellations record', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const call = await server.request('POST', '/calls', {
      callAt: '2026-04-01T09:00',
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'New Job Cancellation',
      jobNumber: 'JN-NEVER-ATTENDED',
    });
    assert.equal(call.status, 201);

    const report = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    assert.equal(report.company.pendingCancellations, 0);
  } finally {
    server.close();
  }
});
