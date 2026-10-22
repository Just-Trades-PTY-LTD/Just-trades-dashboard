import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// Calls Report → "Leads to Sales by Marketing Category". See
// services/reports.js's computeLeadsToSalesByMarketingCategory() /
// drilldownLeadsToSalesByMarketingCategory() for the implementation. Must
// satisfy, in full:
//   - Marketing Category = the existing Lead Source field recorded on the
//     call; blank/null groups under "Unassigned", never excluded
//   - a sale is attributed by Job Number to the call that originally booked
//     it, covering a sale made at the visit, an Approved Later sale, and an
//     Upsell alike
//   - a Job Number with several related Lead calls is never counted as more
//     than one Booked/Converted lead — the earliest call wins attribution
//   - an Upsell/extra sale against an already-converted Job Number adds to
//     the sales value total without creating a second converted lead
//   - date range applies to the original lead's own date (call_at), so a
//     later Approved Later sale can still complete an earlier period's
//     conversion
//   - purely additive/read-only: never mutates calls, jobs or sales

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const sourceA = bundle.lists.lead_source[0];
  const sourceB = bundle.lists.lead_source[1];
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const tech = (await server.request('POST', '/settings/technicians', { name: 'MC Tech' })).data;
  return { plumbing, jobTypeId, sourceA, sourceB, knockbackReasonId, tech };
}

async function logLead(server, { jobNumber, leadSourceId, callAt, booked = 'Yes', callType = 'Lead' }) {
  const res = await server.request('POST', '/calls', {
    callAt,
    direction: 'Inbound',
    callType,
    booked: callType === 'Lead' ? booked : '',
    leadSourceId,
    jobNumber,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

async function newJobNoSale(server, { technicianId, plumbing, jobTypeId, jobNumber, knockbackReasonId, visitDate = '2026-05-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Qualified',
    knockbackReasonId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

async function newJobSaleMade(server, { technicianId, plumbing, jobTypeId, jobNumber, invoiceNumber, saleValueExGst, visitDate = '2026-05-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Qualified',
    invoiceNumber,
    invoiceDate: visitDate,
    saleValueExGst,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

function categoryRow(data, category) {
  return data.leadsToSalesByCategory.rows.find((r) => r.category === category);
}

test('A sale made at the original visit converts the lead and attributes value to its Marketing Category', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-1', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-MC-1', invoiceNumber: 'INV-MC-1', saleValueExGst: 500 });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.leads, 1);
    assert.equal(row.booked, 1);
    assert.equal(row.converted, 1);
    assert.equal(row.notConverted, 0);
    assert.equal(row.totalSalesValueExGst, 500);
    assert.equal(row.averageSaleValue, 500);
  } finally {
    server.close();
  }
});

test('A Booked lead with no matching sale at all counts as Not Converted, never excluded', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-NOSALE', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.leads, 1);
    assert.equal(row.booked, 1);
    assert.equal(row.converted, 0);
    assert.equal(row.notConverted, 1);
    assert.equal(row.totalSalesValueExGst, 0);
  } finally {
    server.close();
  }
});

test('A call with no Marketing Category is grouped under "Unassigned", never dropped from the report', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    await logLead(server, { jobNumber: '', leadSourceId: null, callAt: '2026-05-01T09:00', booked: 'No' });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, 'Unassigned');
    assert.ok(row, 'an Unassigned row exists');
    assert.equal(row.leads, 1);
  } finally {
    server.close();
  }
});

test('An Approved Later sale converts the original lead, attributed to the call\'s own Marketing Category', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, knockbackReasonId, tech } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-APL', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobNoSale(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-MC-APL', knockbackReasonId });

    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-MC-APL',
      newJobNumber: 'AROFLO-MC-APL',
      dateLogged: '2026-05-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-MC-APL',
      invoiceDate: '2026-05-10',
      saleValueExGst: 750,
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.data));

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.converted, 1);
    assert.equal(row.totalSalesValueExGst, 750);
  } finally {
    server.close();
  }
});

test('An Upsell adds to the sales value total without creating a second converted lead', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    const techUpsell = (await server.request('POST', '/settings/technicians', { name: 'MC Upsell Tech' })).data;
    await logLead(server, { jobNumber: 'JN-MC-UPS', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-MC-UPS', invoiceNumber: 'INV-MC-UPS', saleValueExGst: 400 });

    const upsell = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-MC-UPS',
      invoiceNumber: 'INV-MC-UPS',
      dateLogged: '2026-05-05',
      creditedTechnicianId: techUpsell.id,
      invoiceDate: '2026-05-01',
      saleValueExGst: 150,
    });
    assert.equal(upsell.status, 201, JSON.stringify(upsell.data));

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.booked, 1, 'still exactly one converted lead, never two');
    assert.equal(row.converted, 1);
    assert.equal(row.totalSalesValueExGst, 550, 'original sale value plus the upsell value');
  } finally {
    server.close();
  }
});

test('Two Lead calls sharing a Job Number with different Marketing Categories: only the earliest counts, never both', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, sourceB, tech } = await setup(server);
    // Logged out of chronological order on purpose — the earliest call_at
    // must still win regardless of insertion order.
    await logLead(server, { jobNumber: 'JN-MC-CONFLICT', leadSourceId: sourceB.id, callAt: '2026-05-10T09:00' });
    await logLead(server, { jobNumber: 'JN-MC-CONFLICT', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobSaleMade(server, {
      technicianId: tech.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-MC-CONFLICT',
      invoiceNumber: 'INV-MC-CONFLICT',
      saleValueExGst: 300,
    });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const rowA = categoryRow(data, sourceA.name);
    const rowB = categoryRow(data, sourceB.name);
    assert.equal(rowA.booked, 1, "the earliest call's category gets the one booked/converted lead");
    assert.equal(rowA.converted, 1);
    assert.equal(rowB ? rowB.booked : 0, 0, "the later call's category gets none of it");
    assert.equal(rowA.leads, 1, "each call still counts toward its own category's raw Leads total");
    assert.equal(rowB.leads, 1);
  } finally {
    server.close();
  }
});

test('A Call Back sharing the same Job Number is never counted as an additional lead or booking', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-CB', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await logLead(server, { jobNumber: 'JN-MC-CB', leadSourceId: null, callAt: '2026-05-02T09:00', callType: 'Call back' });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.leads, 1, 'the Call back is a different call_type and never counts as a Lead');
    assert.equal(row.booked, 1);
  } finally {
    server.close();
  }
});

test('Date range applies to the original lead date — a later Approved Later sale still completes an earlier period\'s conversion', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, knockbackReasonId, tech } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-DATE', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobNoSale(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-MC-DATE', knockbackReasonId });

    // The Approved Later sale lands in a later month entirely.
    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-MC-DATE',
      newJobNumber: 'AROFLO-MC-DATE',
      dateLogged: '2026-07-15',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-MC-DATE',
      invoiceDate: '2026-07-15',
      saleValueExGst: 900,
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.data));

    // Querying May only (the lead's own date) must still show it converted.
    const mayData = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    const mayRow = categoryRow(mayData, sourceA.name);
    assert.equal(mayRow.converted, 1, "May's lead is converted even though the sale itself was logged in July");
    assert.equal(mayRow.totalSalesValueExGst, 900);

    // July has no leads of its own in scope — the sale is never miscounted
    // as a second, phantom lead in the period it was actually logged in.
    const julyData = (await server.request('GET', '/reports/calls?from=2026-07-01&to=2026-07-31')).data;
    assert.equal(categoryRow(julyData, sourceA.name), undefined, 'no Lead call in July, so no row for this category at all');
  } finally {
    server.close();
  }
});

test('Trade filter narrows Leads to Sales by Marketing Category exactly like every other figure on this report', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const electrical = bundle.trades.find((t) => t.name !== plumbing.name);

    const plumbingLead = await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      booked: 'Yes',
      leadSourceId: sourceA.id,
      tradeId: plumbing.id,
      jobNumber: 'JN-MC-TRADE-P',
    });
    assert.equal(plumbingLead.status, 201);
    const otherLead = await server.request('POST', '/calls', {
      callAt: '2026-05-01T10:00',
      direction: 'Inbound',
      callType: 'Lead',
      booked: 'Yes',
      leadSourceId: sourceA.id,
      tradeId: electrical ? electrical.id : null,
      jobNumber: 'JN-MC-TRADE-E',
    });
    assert.equal(otherLead.status, 201);

    const data = (await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&tradeId=${plumbing.id}`)).data;
    const row = categoryRow(data, sourceA.name);
    assert.equal(row.leads, 1, 'only the Plumbing-trade lead counts once the Trade filter is applied');
  } finally {
    server.close();
  }
});

test('Reading this report section never mutates any call, job, sale or pending-cancellation record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-NOMUT', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-MC-NOMUT', invoiceNumber: 'INV-MC-NOMUT', saleValueExGst: 200 });

    const before = {
      calls: dbAll('SELECT * FROM calls ORDER BY id'),
      jobs: dbAll('SELECT * FROM jobs ORDER BY id'),
      sales: dbAll('SELECT * FROM sales ORDER BY id'),
    };

    await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31');
    await server.request('GET', '/reports/calls/leads-to-sales/drilldown?from=2026-05-01&to=2026-05-31&field=converted&category=' + encodeURIComponent(sourceA.name));
    await server.request('GET', '/reports/calls.xlsx?from=2026-05-01&to=2026-05-31');

    const after = {
      calls: dbAll('SELECT * FROM calls ORDER BY id'),
      jobs: dbAll('SELECT * FROM jobs ORDER BY id'),
      sales: dbAll('SELECT * FROM sales ORDER BY id'),
    };
    assert.deepEqual(after, before);
  } finally {
    server.close();
  }
});

test('The drill-down returns exactly the matching call and sale records for a converted figure, and only calls for Not Converted', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-DD-CONV', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    const sale = await newJobSaleMade(server, {
      technicianId: tech.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-MC-DD-CONV',
      invoiceNumber: 'INV-MC-DD-CONV',
      saleValueExGst: 650,
    });
    await logLead(server, { jobNumber: 'JN-MC-DD-NOCONV', leadSourceId: sourceA.id, callAt: '2026-05-02T09:00' });

    const converted = (
      await server.request(
        'GET',
        `/reports/calls/leads-to-sales/drilldown?from=2026-05-01&to=2026-05-31&field=converted&category=${encodeURIComponent(sourceA.name)}`
      )
    ).data;
    assert.equal(converted.callRows.length, 1);
    assert.equal(converted.callRows[0].jobNumber, 'JN-MC-DD-CONV');
    assert.equal(converted.saleRows.length, 1);
    assert.equal(converted.saleRows[0].id, sale.id);

    const notConverted = (
      await server.request(
        'GET',
        `/reports/calls/leads-to-sales/drilldown?from=2026-05-01&to=2026-05-31&field=notConverted&category=${encodeURIComponent(sourceA.name)}`
      )
    ).data;
    assert.equal(notConverted.callRows.length, 1);
    assert.equal(notConverted.callRows[0].jobNumber, 'JN-MC-DD-NOCONV');
    assert.equal(notConverted.saleRows.length, 0);
  } finally {
    server.close();
  }
});

test('The Totals row drill-down (no category) covers every Marketing Category combined', async () => {
  const server = await startTestServer();
  try {
    const { sourceA, sourceB } = await setup(server);
    await logLead(server, { jobNumber: 'JN-MC-TOT-A', leadSourceId: sourceA.id, callAt: '2026-05-01T09:00' });
    await logLead(server, { jobNumber: 'JN-MC-TOT-B', leadSourceId: sourceB.id, callAt: '2026-05-02T09:00' });

    const data = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;
    assert.equal(data.leadsToSalesByCategory.totals.leads, 2);

    const drilldown = (
      await server.request('GET', '/reports/calls/leads-to-sales/drilldown?from=2026-05-01&to=2026-05-31&field=leads')
    ).data;
    assert.equal(drilldown.callRows.length, 2, 'omitting category covers every Marketing Category combined');
  } finally {
    server.close();
  }
});
