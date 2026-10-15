import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// "View original knockback job" — a Quote Approved Later ("Converted Later")
// entry's exact, hard link back to the specific job it flipped from
// knock-back to converted, exposed as entry.originalKnockbackJobId (the
// reverse of jobs.converted_by_sale_id — see routes/techSales.js's own POST
// /quote-approved-later). This must:
//   - be the EXACT job id that was actually converted, never merely a
//     job_number text match (which could coincidentally hit a different job
//     sharing that same JN)
//   - be null whenever this sale never had a matching active knock-back to
//     convert at creation (e.g. an extra invoice on an already-sold job) —
//     correctly "not linked", never a guessed/incorrect match
//   - agree between the single-entry create/edit response and the batched
//     GET /tech/entries list
//   - never change report figures or any existing record

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const tech = (await server.request('POST', '/settings/technicians', { name: 'Original Job Link Tech' })).data;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  return { plumbing, jobTypeId, tech, knockbackReasonId };
}

test('a Quote Approved Later entry links to the exact job it converted, both on creation and in the entries list', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech, knockbackReasonId } = await setup(server);

    const knockbackJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-01',
      technicianId: tech.id,
      jobNumber: 'OKJ-LINKED-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      knockbackReasonId,
    });
    assert.equal(knockbackJob.status, 201);
    const jobId = knockbackJob.data.entry.id;

    const approvedLater = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'OKJ-LINKED-1',
      newJobNumber: 'OKJ-LINKED-1-NEW',
      dateLogged: '2026-08-05',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-OKJ-LINKED-1',
      invoiceDate: '2026-08-05',
      saleValueExGst: 500,
    });
    assert.equal(approvedLater.status, 201, JSON.stringify(approvedLater.data));
    assert.equal(approvedLater.data.entry.originalKnockbackJobId, jobId, 'the create response links to the exact job that was converted');

    // Editing the sale never recomputes or disturbs this link.
    const edited = await server.request('PATCH', `/tech/quote-approved-later/${approvedLater.data.entry.id}`, {
      comments: 'edited — link must stay the same',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.originalKnockbackJobId, jobId, 'editing the sale does not change its original-knock-back link');

    // The batched entries list agrees with the single-entry responses above.
    const entries = (await server.request('GET', '/tech/entries')).data;
    const listedSale = entries.find((e) => e.kind === 'quote_approved_later' && e.id === approvedLater.data.entry.id);
    assert.ok(listedSale, 'the sale appears in the entries list');
    assert.equal(listedSale.originalKnockbackJobId, jobId, 'the entries list shows the same exact link');

    // Archiving the original job never clears the link — it's still the
    // exact same job, just archived.
    await server.request('PATCH', `/tech/entries/new_job_no_sale/${jobId}/archive`, { archived: true });
    const afterArchive = (await server.request('GET', '/tech/entries?includeArchived=true')).data;
    const stillLinked = afterArchive.find((e) => e.kind === 'quote_approved_later' && e.id === approvedLater.data.entry.id);
    assert.equal(stillLinked.originalKnockbackJobId, jobId, 'archiving the original job does not clear its link');
  } finally {
    server.close();
  }
});

test('a Quote Approved Later entry used only to add an extra invoice to an already-sold job is correctly shown as not linked', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);

    // A Sale Made job — never a knock-back, so there is nothing for this
    // Quote Approved Later entry to convert.
    const saleMadeJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-08-01',
      technicianId: tech.id,
      jobNumber: 'OKJ-UNLINKED-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      invoiceNumber: 'INV-ANCHOR-OKJ-UNLINKED-1',
      invoiceDate: '2026-08-01',
      saleValueExGst: 200,
    });
    assert.equal(saleMadeJob.status, 201);

    const extraInvoice = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'OKJ-UNLINKED-1',
      newJobNumber: 'OKJ-UNLINKED-1-NEW',
      dateLogged: '2026-08-05',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-OKJ-UNLINKED-1',
      invoiceDate: '2026-08-05',
      saleValueExGst: 150,
    });
    assert.equal(extraInvoice.status, 201, JSON.stringify(extraInvoice.data));
    assert.equal(extraInvoice.data.entry.originalKnockbackJobId, null, 'no active knock-back existed to convert, so this is correctly not linked');

    const entries = (await server.request('GET', '/tech/entries')).data;
    const listedSale = entries.find((e) => e.kind === 'quote_approved_later' && e.id === extraInvoice.data.entry.id);
    assert.equal(listedSale.originalKnockbackJobId, null, 'the entries list agrees: not linked');
  } finally {
    server.close();
  }
});

test('original-job-link lookups never alter any job, sale, or report figure', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech, knockbackReasonId } = await setup(server);
    const knockbackJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-01',
      technicianId: tech.id,
      jobNumber: 'OKJ-REPORT-SAFE-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      knockbackReasonId,
    });
    assert.equal(knockbackJob.status, 201);

    const approvedLater = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'OKJ-REPORT-SAFE-1',
      newJobNumber: 'OKJ-REPORT-SAFE-1-NEW',
      dateLogged: '2026-09-05',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-OKJ-REPORT-SAFE-1',
      invoiceDate: '2026-09-05',
      saleValueExGst: 400,
    });
    assert.equal(approvedLater.status, 201);

    // "before" is read only now, once the Converted Later flip (a legitimate,
    // pre-existing effect of creating the sale itself) has already happened —
    // what this test actually checks is that merely READING the new
    // originalKnockbackJobId link (as the UI link does, repeatedly) never
    // itself changes any figure further.
    const before = (await server.request('GET', '/reports/tech?from=2026-09-01&to=2026-09-30')).data;
    await server.request('GET', '/tech/entries');
    await server.request('GET', '/tech/entries');
    await server.request('GET', `/tech/entries/quote_approved_later/${approvedLater.data.entry.id}/history`);

    const after = (await server.request('GET', '/reports/tech?from=2026-09-01&to=2026-09-30')).data;
    assert.deepEqual(after.company, before.company, 'company-level figures unaffected by repeatedly reading the new original-knock-back-job link');
  } finally {
    server.close();
  }
});
