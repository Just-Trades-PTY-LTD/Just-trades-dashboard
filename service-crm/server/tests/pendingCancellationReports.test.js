import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// Pending Cancellations change the sales figures (decided 26 Nov 2026):
// entire invoice -> the sale (and Upsells on that invoice) stop counting; part
// of the work -> one sale at AroFlo's reduced invoice amount (or recorded
// amount less lost value until AroFlo shows a lower amount). Original invoice
// period, straight away. Never a knockback; Converted Later credit kept.
// Older cancellations with nothing recorded change nothing. Records unchanged.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const pl = b.trades.find((t) => t.name === 'Plumbing');
  const [google] = b.lists.lead_source;
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tylor' }));
  const lead = (jn) => server.request('POST', '/calls', { direction: 'Inbound', callType: 'Lead', booked: 'Yes', tradeId: pl.id, leadSourceId: google.id, jobNumber: jn, callAt: '2026-11-01T09:00' });
  const sold = async (jn, value, visit = '2026-11-03') => {
    ok(await lead(jn));
    return ok(
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made', visitDate: visit, technicianId: tech.id, jobNumber: jn, tradeId: pl.id, jobTypeId: pl.jobTypes[0].id,
        lead: 'Qualified', invoiceNumber: `INV-${jn}`, invoiceDate: visit, saleValueExGst: value,
      })
    ).entry;
  };
  await sold('P1', 1000);
  await sold('P2', 2000);
  await sold('P4', 1500);
  await sold('P5', 700);
  ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'P2', invoiceNumber: 'INV-P2', dateLogged: '2026-11-04', creditedTechnicianId: tech.id, invoiceDate: '2026-11-03', saleValueExGst: 200 }));
  // A knockback converted the same week by an approved quote (P3 install).
  ok(await lead('K1'));
  ok(
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-11-03', technicianId: tech.id, jobNumber: 'K1', tradeId: pl.id, jobTypeId: pl.jobTypes[0].id,
      lead: 'Qualified', knockbackReasonId: b.lists.knockback_reason[0].id,
    })
  );
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'K1', newJobNumber: 'P3', dateLogged: '2026-11-05', creditedTechnicianId: tech.id, invoiceNumber: 'INV-P3', invoiceDate: '2026-11-05', saleValueExGst: 500 }));

  const reason = b.lists.pending_cancellation_reason?.[0]?.id;
  // Logged in December — the figures change in November (the invoice period).
  const cancel = (jn, details) =>
    server.request('POST', '/calls', {
      callAt: '2026-12-02T09:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: jn, cancellationReasonId: reason,
      ...(details ? { pendingCancellationDetails: { invoiceDate: '2026-11-03', arofloInvoiceId: 'X', arofloInvoiceStatus: 'APPROVED', arofloCapturedAt: '2026-12-02T00:00:00Z', ...details } } : {}),
    });
  return { tech, google, cancel };
}

const nov = (server, q = '') => server.request('GET', `/reports/tech?from=2026-11-01&to=2026-11-30${q}`);

test('Pending Cancellations: entire invoice removes the sale; part uses the reduced amount; credits and knockbacks unchanged; records untouched', async () => {
  const server = await startTestServer();
  try {
    const { cancel } = await seed(server);
    const before = ok(await nov(server)).company;
    assert.deepEqual([before.sales, before.totalSaleExGst], [5, 1000 + 2000 + 1500 + 700 + 500 + 200]);
    assert.deepEqual([before.convertedLaterCredits, before.adjustedKnockbacks], [1, 0]);
    const salesBefore = JSON.stringify(dbAll('SELECT * FROM sales ORDER BY id'));

    ok(await cancel('P2', { invoiceNumber: 'INV-P2', arofloInvoiceValueExGst: 2200, lostValueExGst: 2200, lostValueBasis: 'whole_sale' }));
    ok(await cancel('P3', { invoiceNumber: 'INV-P3', arofloInvoiceValueExGst: 500, lostValueExGst: 500, lostValueBasis: 'whole_sale' }));
    ok(await cancel('P1', { invoiceNumber: 'INV-P1', arofloInvoiceValueExGst: 600, lostValueExGst: 400, lostValueBasis: 'part_of_work' }));
    ok(await cancel('P4', { invoiceNumber: 'INV-P4', arofloInvoiceValueExGst: 1500, lostValueExGst: 300, lostValueBasis: 'part_of_work' }));
    ok(await cancel('P5')); // older style: nothing recorded

    const r = ok(await nov(server));
    const c = r.company;
    assert.equal(c.sales, 3, 'P2 and P3 cancelled in full; P1, P4 (part) and P5 still count');
    assert.equal(c.totalSaleExGst, 600 + 1200 + 700, 'P1 at AroFlo\'s $600, P4 at $1,500 − $300, P5 unchanged; P2 + its Upsell and P3 gone');
    assert.equal(c.upsellsCount, 0);
    assert.equal(c.convertedLaterCredits, 1, 'the cancelled approved quote keeps its Converted Later credit');
    assert.equal(c.adjustedKnockbacks, 0);
    assert.equal(c.knockbacks, before.knockbacks, 'a cancelled sale never becomes a knockback');
    assert.equal(c.jobsAttended, before.jobsAttended);
    assert.deepEqual(c.cancellations, { fullCount: 2, fullValueExGst: 2700, partCount: 2, partReductionExGst: 700 });

    const t = r.byTechnician.find((x) => x.name === 'Tylor');
    assert.deepEqual([t.sales, t.totalSaleExGst], [3, 2500]);
    const g = r.salesByMarketingCategory.rows.reduce((tot, x) => ({ sales: tot.sales + x.sales, value: tot.value + x.totalSalesValueExGst }), { sales: 0, value: 0 });
    assert.deepEqual(g, { sales: 3, value: 2500 }, 'marketing categories match the totals');

    const dec = ok(await server.request('GET', '/reports/tech?from=2026-12-01&to=2026-12-31')).company;
    assert.equal(dec.sales, 0, 'nothing moves into the month the cancellation was logged');

    const drill = ok(await server.request('GET', '/reports/tech/drilldown?from=2026-11-01&to=2026-11-30&metric=cancelledSales'));
    assert.equal(drill.rows.length, 5, 'P2, P3, its Upsell, P1 and P4');

    const entries = ok(await server.request('GET', '/tech/entries'));
    const status = (jn) => entries.find((e) => e.kind === 'new_job_sale_made' && e.jobNumber === jn)?.cancellation;
    assert.equal(status('P2').type, 'full');
    assert.equal(status('P1').type, 'partial');
    assert.equal(status('P1').reportedValue, 600);
    assert.equal(status('P4').reportedValue, 1200);
    assert.equal(status('P5'), null);
    assert.equal(JSON.stringify(dbAll('SELECT * FROM sales ORDER BY id')), salesBefore, 'no sale record is changed');

    const dh = ok(await server.request('GET', '/data-health')).checks.find((x) => x.id === 'pendingCancellationNotRecorded');
    assert.deepEqual(dh.rows.map((x) => x.jobNumber), ['P5']);
  } finally {
    server.close();
  }
});
