import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Mirrors HANDOVER.md §6 worked example exactly:
// 9 March — visit, knock-back. 16 March — quote approved later, same JN.
// Expect: one Job row throughout, knock-back flips to converted, one Sale,
// jobs-attended never double counts.
test('§6 worked example: knock-back flips to converted, job counted once', async () => {
  const server = await startTestServer();
  try {
    await server.login();

    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // 9 March: New Job — No Sale
    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2025-03-09',
      technicianId: tech.id,
      jobNumber: 'JN-10432',
      tradeId: plumbing.id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0]?.id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.entry.knockback, true);
    assert.equal(created.data.entry.convertedLater, false);

    let report = (await server.request('GET', '/reports/tech?from=2025-03-01&to=2025-03-31')).data;
    assert.equal(report.company.jobsAttended, 1, 'one visit logged so far');
    assert.equal(report.company.knockbacks, 1, 'knock-back rate is 100% before the approval');
    assert.equal(report.company.knockbackRate, 100);
    assert.equal(report.company.sales, 0);

    // 16 March: Existing Job — Quote Approved Later, same JN
    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-10432',
      dateLogged: '2025-03-16',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-5541',
      invoiceDate: '2025-03-16',
      saleValueExGst: 480,
    });
    assert.equal(approved.status, 201);
    assert.equal(approved.data.notice, null, 'a matching knock-back should be found, so no "no match" notice');

    // Re-run the March report: jobs attended unchanged, knock-back gone,
    // converted-later +1, one sale for $480 ex GST.
    report = (await server.request('GET', '/reports/tech?from=2025-03-01&to=2025-03-31')).data;
    assert.equal(report.company.jobsAttended, 1, 'still one visit — never double-counted');
    assert.equal(report.company.knockbacks, 0);
    assert.equal(report.company.convertedLaterCount, 1);
    assert.equal(report.company.conversionRate, 100);
    assert.equal(report.company.sales, 1);
    assert.equal(report.company.totalSaleExGst, 480);

    // The underlying job row itself must show the flip, with an audit trail.
    const entries = (await server.request('GET', '/tech/entries?from=2025-03-01&to=2025-03-31')).data;
    const job = entries.find((e) => e.kind === 'new_job_no_sale');
    assert.ok(job);
    assert.equal(job.convertedLater, true);
    const history = (await server.request('GET', `/tech/entries/new_job_no_sale/${job.id}/history`)).data;
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].changes.knockback, { from: 'Yes', to: 'Converted (quote approved later)' });

    // Knock-back/conversion figures reflect each job's *current* status, not
    // a historical snapshot — filtering the visit-date range to before the
    // approval still shows it as converted (the job itself was mutated), so
    // this differs from what a report literally run on 10 March would have
    // shown. Only the sale itself (dated by invoice date) drops out of range.
    const beforeApproval = (await server.request('GET', '/reports/tech?from=2025-03-01&to=2025-03-15')).data;
    assert.equal(beforeApproval.company.jobsAttended, 1);
    assert.equal(beforeApproval.company.knockbacks, 0);
    assert.equal(beforeApproval.company.convertedLaterCount, 1);
    assert.equal(beforeApproval.company.sales, 0, 'the sale is dated 16 March by invoice date, outside this range');
  } finally {
    server.close();
  }
});
