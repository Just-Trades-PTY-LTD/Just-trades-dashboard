import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, run as dbRun } from '../src/db/index.js';

// Technician & Sales Report → "Revenue by Suburb". See services/reports.js's
// computeRevenueBySuburb()/drilldownTech's 'revenueBySuburb' case. Must
// satisfy, in full:
//   - a sale/upsell is attributed to its ORIGINAL job's suburb, never its
//     own (often blank, for a non-Upsell) column — same resolution as the
//     Suburb filter
//   - the sum of every suburb's Total Sales Value ex GST reconciles exactly
//     with the main report's own Total sale value (ex GST) KPI — same
//     population, same Upsell-inclusion rule
//   - Number of Sales / Average Sale Value are original (non-Upsell) sales
//     only, matching Sales (invoices)/Average Sale's own population
//   - a missing/unlinkable suburb goes under "Unassigned", never excluded
//   - sorted by Total Sales Value ex GST descending by default
//   - purely additive/read-only

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const tech = (await server.request('POST', '/settings/technicians', { name: 'RBS Tech' })).data;
  return { plumbing, jobTypeId, knockbackReasonId, tech };
}

function suburbRow(data, suburb) {
  return data.revenueBySuburb.find((r) => r.suburb === suburb);
}

test('A sale made at the visit is attributed to its job\'s suburb', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-01',
      technicianId: tech.id,
      jobNumber: 'JN-RBS-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      invoiceNumber: 'INV-RBS-1',
      invoiceDate: '2026-05-01',
      saleValueExGst: 400,
      suburb: 'Glenelg (5045)',
    });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const row = suburbRow(data, 'Glenelg (5045)');
    assert.ok(row, 'a row exists for this suburb');
    assert.equal(row.totalSalesValueExGst, 400);
    assert.equal(row.salesCount, 1);
    assert.equal(row.averageSaleValue, 400);
  } finally {
    server.close();
  }
});

test('A Quote Approved Later sale auto-fills its suburb from the ORIGINAL job at creation, and is attributed to it', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-05-01',
      technicianId: tech.id,
      jobNumber: 'JN-RBS-APL',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      knockbackReasonId,
      suburb: 'Unley (5061)',
    });
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-RBS-APL',
      newJobNumber: 'AROFLO-RBS-APL',
      dateLogged: '2026-05-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-RBS-APL',
      invoiceDate: '2026-05-10',
      saleValueExGst: 600,
      // no suburb given — auto-filled from the matched original job
    });

    const sale = dbAll("SELECT suburb FROM sales WHERE invoice_number = 'INV-RBS-APL'")[0];
    assert.equal(sale.suburb, 'Unley (5061)', "auto-filled from the original job at creation, same as Upsell");

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const row = suburbRow(data, 'Unley (5061)');
    assert.ok(row, "found under the original job's suburb");
    assert.equal(row.totalSalesValueExGst, 600);
    assert.equal(row.salesCount, 1);
  } finally {
    server.close();
  }
});

test('A Quote Approved Later sale with no stored suburb (a legacy record) still resolves via the ORIGINAL job, without rewriting the row', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-LEGACY',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId, suburb: 'Prospect (5082)',
    });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-RBS-LEGACY', newJobNumber: 'AROFLO-RBS-LEGACY', dateLogged: '2026-05-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-RBS-LEGACY', invoiceDate: '2026-05-10', saleValueExGst: 450,
    });
    // Simulate a legacy row saved before this field existed — blank stored
    // suburb, never rewritten by this fix.
    dbRun("UPDATE sales SET suburb = '' WHERE id = ?", [created.data.entry.id]);

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const row = suburbRow(data, 'Prospect (5082)');
    assert.ok(row, "resolves via the linked original job despite the blank stored column");
    assert.equal(row.totalSalesValueExGst, 450);

    const sale = dbAll('SELECT suburb FROM sales WHERE id = ?', [created.data.entry.id])[0];
    assert.equal(sale.suburb, '', 'the stored row itself is never backfilled just by reading a report');
  } finally {
    server.close();
  }
});

test('A deliberately saved suburb on a Quote Approved Later sale overrides the original job\'s suburb for that sale\'s own attribution', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-OVERRIDE',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId, suburb: 'Kensington (5068)',
    });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-RBS-OVERRIDE', newJobNumber: 'AROFLO-RBS-OVERRIDE', dateLogged: '2026-05-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-RBS-OVERRIDE', invoiceDate: '2026-05-10', saleValueExGst: 700,
      suburb: 'Corrected Suburb (5099)',
    });
    assert.equal(created.data.entry.suburb, 'Corrected Suburb (5099)');

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    assert.ok(suburbRow(data, 'Corrected Suburb (5099)'), 'attributed under the deliberately saved suburb');
    assert.equal(suburbRow(data, 'Kensington (5068)'), undefined, 'never also attributed under the original job\'s own suburb');

    // The original job itself is never touched.
    const job = dbAll("SELECT suburb FROM jobs WHERE job_number = 'JN-RBS-OVERRIDE'")[0];
    assert.equal(job.suburb, 'Kensington (5068)', "the original job's own suburb is unchanged");
  } finally {
    server.close();
  }
});

test('A sale with no reliably linked suburb falls under Unassigned, never excluded', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-01',
      technicianId: tech.id,
      jobNumber: 'JN-RBS-NOSUB',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      invoiceNumber: 'INV-RBS-NOSUB',
      invoiceDate: '2026-05-01',
      saleValueExGst: 150,
      // no suburb given at all
    });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const row = suburbRow(data, 'Unassigned');
    assert.ok(row, 'an Unassigned row exists');
    assert.equal(row.totalSalesValueExGst, 150);
  } finally {
    server.close();
  }
});

test('Upsell value is included in the suburb total but never counted as its own sale', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    const techUpsell = (await server.request('POST', '/settings/technicians', { name: 'RBS Upsell Tech' })).data;
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-01',
      technicianId: tech.id,
      jobNumber: 'JN-RBS-UPS',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      invoiceNumber: 'INV-RBS-UPS',
      invoiceDate: '2026-05-01',
      saleValueExGst: 300,
      suburb: 'Norwood (5067)',
    });
    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-RBS-UPS',
      invoiceNumber: 'INV-RBS-UPS',
      dateLogged: '2026-05-05',
      creditedTechnicianId: techUpsell.id,
      invoiceDate: '2026-05-01',
      saleValueExGst: 100,
    });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const row = suburbRow(data, 'Norwood (5067)');
    assert.equal(row.totalSalesValueExGst, 400, 'original sale plus upsell value');
    assert.equal(row.salesCount, 1, 'the upsell is never counted as its own sale');
    assert.equal(row.averageSaleValue, 400, 'Total ÷ Number of Sales, so the row stays internally consistent');
  } finally {
    server.close();
  }
});

test('Every suburb\'s Total Sales Value ex GST sums to exactly the main report\'s own Total sale value (ex GST)', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    const techUpsell = (await server.request('POST', '/settings/technicians', { name: 'RBS Recon Upsell' })).data;

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-R1',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-R1', invoiceDate: '2026-05-01',
      saleValueExGst: 250, suburb: 'Suburb A',
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-02', technicianId: tech.id, jobNumber: 'JN-RBS-R2',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-R2', invoiceDate: '2026-05-02',
      saleValueExGst: 310, suburb: 'Suburb B',
    });
    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-RBS-R2', invoiceNumber: 'INV-RBS-R2', dateLogged: '2026-05-06',
      creditedTechnicianId: techUpsell.id, invoiceDate: '2026-05-02', saleValueExGst: 45,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: tech.id, jobNumber: 'JN-RBS-R3',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-R3', invoiceDate: '2026-05-03',
      saleValueExGst: 90,
      // no suburb -> Unassigned
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-05-04', technicianId: tech.id, jobNumber: 'JN-RBS-R4',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId, suburb: 'Suburb C',
    });
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-RBS-R4', newJobNumber: 'AROFLO-RBS-R4', dateLogged: '2026-05-20',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-RBS-R4', invoiceDate: '2026-05-20', saleValueExGst: 500,
    });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const sumAcrossSuburbs = data.revenueBySuburb.reduce((s, r) => s + r.totalSalesValueExGst, 0);
    assert.equal(sumAcrossSuburbs, data.company.totalSaleExGst, 'reconciles exactly with the main report\'s own figure');
    assert.equal(data.company.totalSaleExGst, 250 + 310 + 45 + 90 + 500);

    const sumOfCounts = data.revenueBySuburb.reduce((s, r) => s + r.salesCount, 0);
    assert.equal(sumOfCounts, data.company.sales, 'Number of Sales also reconciles with Sales (invoices)');

    // Sorted by Total Sales Value ex GST descending by default.
    const totals = data.revenueBySuburb.map((r) => r.totalSalesValueExGst);
    const sorted = [...totals].sort((a, b) => b - a);
    assert.deepEqual(totals, sorted);
  } finally {
    server.close();
  }
});

test('Revenue by Suburb respects Date Range, Technician, Trade, Job Type and Lead Source, same as the main report', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const sourceA = bundle.lists.lead_source[0];
    const otherTech = (await server.request('POST', '/settings/technicians', { name: 'RBS Other Tech' })).data;

    await server.request('POST', '/calls', {
      callAt: '2026-04-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes',
      leadSourceId: sourceA.id, jobNumber: 'JN-RBS-FILT1',
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-FILT1',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-FILT1', invoiceDate: '2026-05-01',
      saleValueExGst: 200, suburb: 'Filt Suburb 1',
    });
    // A different technician's sale, same month — must be excluded once filtered to `tech`.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-01', technicianId: otherTech.id, jobNumber: 'JN-RBS-FILT2',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-FILT2', invoiceDate: '2026-05-01',
      saleValueExGst: 999, suburb: 'Filt Suburb 2',
    });

    const data = (await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&technicianId=${tech.id}&tradeId=${plumbing.id}&leadSourceId=${sourceA.id}`)).data;
    assert.equal(data.revenueBySuburb.length, 1);
    assert.equal(data.revenueBySuburb[0].suburb, 'Filt Suburb 1');
    assert.equal(data.revenueBySuburb[0].totalSalesValueExGst, 200);
  } finally {
    server.close();
  }
});

test('The drill-down returns exactly the matching records for Total Sales Value, and only non-Upsell sales for Number of Sales', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    const techUpsell = (await server.request('POST', '/settings/technicians', { name: 'RBS DD Upsell' })).data;
    const job = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-DD1',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-DD1', invoiceDate: '2026-05-01',
      saleValueExGst: 220, suburb: 'DD Suburb',
    });
    const upsell = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-RBS-DD1', invoiceNumber: 'INV-RBS-DD1', dateLogged: '2026-05-05',
      creditedTechnicianId: techUpsell.id, invoiceDate: '2026-05-01', saleValueExGst: 60,
    });

    const totalDD = (
      await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=revenueBySuburb&category=${encodeURIComponent('DD Suburb')}&field=totalSalesValue`)
    ).data;
    assert.equal(totalDD.count, 2, 'the job (sale made at visit) and the upsell both appear');

    const countDD = (
      await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=revenueBySuburb&category=${encodeURIComponent('DD Suburb')}&field=salesCount`)
    ).data;
    assert.equal(countDD.count, 1, 'only the original sale/job counts toward Number of Sales');
    assert.equal(countDD.rows[0].id, job.data.entry.id);
  } finally {
    server.close();
  }
});

test('Reading Revenue by Suburb never mutates any job, sale or call record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-01', technicianId: tech.id, jobNumber: 'JN-RBS-NOMUT',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-RBS-NOMUT', invoiceDate: '2026-05-01',
      saleValueExGst: 330, suburb: 'No Mutate Suburb',
    });

    const before = { jobs: dbAll('SELECT * FROM jobs ORDER BY id'), sales: dbAll('SELECT * FROM sales ORDER BY id') };
    await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31');
    await server.request(
      'GET',
      `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=revenueBySuburb&category=${encodeURIComponent('No Mutate Suburb')}&field=totalSalesValue`
    );
    await server.request('GET', '/reports/tech.xlsx?from=2026-05-01&to=2026-05-31');
    const after = { jobs: dbAll('SELECT * FROM jobs ORDER BY id'), sales: dbAll('SELECT * FROM sales ORDER BY id') };
    assert.deepEqual(after, before);
  } finally {
    server.close();
  }
});
