import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('a "New Job — Sale Made" entry cannot be permanently deleted (linked sale), and nothing is removed', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const job = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made',
        visitDate: '2026-05-01',
        jobNumber: 'JN-DELSAFE-1',
        tradeId: plumbing.id,
        lead: 'Qualified',
        invoiceNumber: 'INV-DELSAFE-1',
        invoiceDate: '2026-05-01',
        saleValueExGst: 500,
      })
    ).data.entry;

    const entriesBefore = (await server.request('GET', '/tech/entries')).data;
    const entryBefore = entriesBefore.find((e) => e.jobNumber === 'JN-DELSAFE-1');
    assert.equal(entryBefore.canDelete, false, 'listTechEntries must flag this entry as not deletable');

    const del = await server.request('DELETE', `/tech/entries/new_job_sale_made/${job.id}`);
    assert.equal(del.status, 409, 'delete must be refused with 409, not crash with a raw 500');
    assert.equal(del.data.error, 'This entry has linked sales or job information and cannot be permanently deleted. Please archive it instead.');

    const entriesAfter = (await server.request('GET', '/tech/entries')).data;
    assert.ok(entriesAfter.some((e) => e.jobNumber === 'JN-DELSAFE-1'), 'the entry must still exist — nothing was deleted');
  } finally {
    server.close();
  }
});

test('a knock-back job that was later converted by a Quote Approved Later sale cannot be deleted, and neither can the sale', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const job = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-05-02',
        jobNumber: 'JN-DELSAFE-2',
        tradeId: plumbing.id,
        lead: 'Qualified',
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      })
    ).data.entry;

    const sale = (
      await server.request('POST', '/tech/quote-approved-later', {
        jobNumber: 'JN-DELSAFE-2',
        dateLogged: '2026-05-10',
        invoiceNumber: 'INV-DELSAFE-2',
        invoiceDate: '2026-05-10',
        saleValueExGst: 300,
      })
    ).data.entry;

    const entries = (await server.request('GET', '/tech/entries')).data;
    const jobEntry = entries.find((e) => e.jobNumber === 'JN-DELSAFE-2' && e.kind === 'new_job_no_sale');
    const saleEntry = entries.find((e) => e.kind === 'quote_approved_later' && e.id === sale.id);
    assert.equal(jobEntry.canDelete, false, 'the converted job must be flagged as not deletable');
    assert.equal(saleEntry.canDelete, false, 'the converting sale must be flagged as not deletable');

    const delJob = await server.request('DELETE', `/tech/entries/new_job_no_sale/${job.id}`);
    assert.equal(delJob.status, 409);
    const delSale = await server.request('DELETE', `/tech/entries/quote_approved_later/${sale.id}`);
    assert.equal(delSale.status, 409);

    const entriesAfter = (await server.request('GET', '/tech/entries')).data;
    assert.ok(entriesAfter.some((e) => e.id === job.id && e.kind === 'new_job_no_sale'), 'the job must still exist');
    assert.ok(entriesAfter.some((e) => e.id === sale.id && e.kind === 'quote_approved_later'), 'the sale must still exist');
  } finally {
    server.close();
  }
});

test('an unconverted knock-back job, a Call Back, and a Pending Cancellation can still be deleted normally (no dependencies)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const job = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-05-03',
        jobNumber: 'JN-DELSAFE-3',
        tradeId: plumbing.id,
        lead: 'Qualified',
        knockbackReasonId: bundle.lists.knockback_reason[0].id,
      })
    ).data.entry;

    const callBack = (
      await server.request('POST', '/tech/call-backs', {
        jobNumber: 'JN-DELSAFE-4',
        visitDate: '2026-05-04',
        comments: 'test',
      })
    ).data.entry;

    const pendingCancel = (
      await server.request('POST', '/tech/pending-cancellations', {
        jobNumber: 'JN-DELSAFE-5',
        dateLogged: '2026-05-05',
        comments: 'test',
      })
    ).data.entry;

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.find((e) => e.id === job.id && e.kind === 'new_job_no_sale').canDelete, true);
    assert.equal(entries.find((e) => e.id === callBack.id && e.kind === 'call_back').canDelete, true);
    assert.equal(entries.find((e) => e.id === pendingCancel.id && e.kind === 'pending_cancellation').canDelete, true);

    assert.equal((await server.request('DELETE', `/tech/entries/new_job_no_sale/${job.id}`)).status, 200);
    assert.equal((await server.request('DELETE', `/tech/entries/call_back/${callBack.id}`)).status, 200);
    assert.equal((await server.request('DELETE', `/tech/entries/pending_cancellation/${pendingCancel.id}`)).status, 200);

    const entriesAfter = (await server.request('GET', '/tech/entries')).data;
    assert.ok(!entriesAfter.some((e) => e.id === job.id && e.kind === 'new_job_no_sale'));
    assert.ok(!entriesAfter.some((e) => e.id === callBack.id && e.kind === 'call_back'));
    assert.ok(!entriesAfter.some((e) => e.id === pendingCancel.id && e.kind === 'pending_cancellation'));
  } finally {
    server.close();
  }
});
