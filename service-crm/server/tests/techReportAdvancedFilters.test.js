import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// New Technician & Sales Report filters: Lead Qualification, Lead Source (via
// the original Lead call's Job Number, same attribution rule as Leads to
// Sales), Sale Made, Knockback status, Suburb, Job Number, Entry Type. See
// services/reports.js's matchesJobLevelFilters/applyLinkedJobFilters for the
// implementation. Must satisfy, in full:
//   - a Jobs-only filter (Lead Qualification, Sale Made, Knockback status)
//     narrows Sales/Upsells/Call Backs/Pending Cancellations too, via each
//     row's own original job — never left unfiltered alongside a narrowed
//     Jobs count
//   - Lead Source resolves identically to the already-shipped Leads to Sales
//     attribution (earliest Lead call wins)
//   - Suburb resolves via the original job for Sales/Call Backs/Pending
//     Cancellations (which have no reliable suburb of their own), never the
//     row's own blank/absent column
//   - Entry Type genuinely empties every other population, never a
//     misleading zero computed as if that population had simply been
//     filtered down to nothing
//   - purely additive/read-only: never mutates jobs, sales or calls

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const sourceA = bundle.lists.lead_source[0];
  const tech = (await server.request('POST', '/settings/technicians', { name: 'AF Tech' })).data;
  return { plumbing, jobTypeId, knockbackReasonId, sourceA, tech };
}

async function logLeadCall(server, { jobNumber, leadSourceId, callAt }) {
  const res = await server.request('POST', '/calls', {
    callAt,
    direction: 'Inbound',
    callType: 'Lead',
    booked: 'Yes',
    leadSourceId,
    jobNumber,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

async function newJobNoSale(server, { technicianId, plumbing, jobTypeId, jobNumber, lead, knockbackReasonId, suburb, visitDate = '2026-05-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead,
    knockbackReasonId: lead === 'Qualified' ? knockbackReasonId : null,
    suburb,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

async function newJobSaleMade(server, { technicianId, plumbing, jobTypeId, jobNumber, lead, invoiceNumber, saleValueExGst, suburb, visitDate = '2026-05-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead,
    invoiceNumber,
    invoiceDate: visitDate,
    saleValueExGst,
    suburb,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('Lead Qualification filter narrows Total Jobs, and propagates to Sales via each sale\'s own original job', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-Q1', lead: 'Qualified', invoiceNumber: 'INV-AF-Q1', saleValueExGst: 400 });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-NQ1', lead: 'Not Qualified', invoiceNumber: 'INV-AF-NQ1', saleValueExGst: 999 });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&leadQualification=Qualified')).data;
    assert.equal(data.company.jobsAttended, 1, 'only the Qualified job counts');
    assert.equal(data.company.totalSaleExGst, 400, 'the Not Qualified job\'s sale is excluded even though it has no leadQualification column of its own');
  } finally {
    server.close();
  }
});

test('Sale Made filter on Jobs propagates to exclude a Quote Approved Later sale whose original job doesn\'t match', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    // A genuine knock-back (Sale Made = No at the visit) later converted —
    // Sale Made still reflects the ORIGINAL visit outcome, not the later sale.
    await newJobNoSale(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-SM1', lead: 'Qualified', knockbackReasonId });
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-AF-SM1',
      newJobNumber: 'AROFLO-AF-SM1',
      dateLogged: '2026-05-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-AF-SM1',
      invoiceDate: '2026-05-10',
      saleValueExGst: 650,
    });

    const saleMadeNo = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&saleMade=No')).data;
    assert.equal(saleMadeNo.company.jobsAttended, 1, 'the job itself still reads Sale Made = No at the visit');
    assert.equal(saleMadeNo.company.totalSaleExGst, 650, 'its Approved Later sale is included — its original job matches Sale Made = No');

    const saleMadeYes = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&saleMade=Yes')).data;
    assert.equal(saleMadeYes.company.jobsAttended, 0);
    assert.equal(saleMadeYes.company.totalSaleExGst, 0, 'the same sale is excluded under Sale Made = Yes, since its original job never matches that');
  } finally {
    server.close();
  }
});

test('Lead Source on the Technician & Sales Report resolves identically to Leads to Sales\' own attribution', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    await logLeadCall(server, { jobNumber: 'JN-AF-LS1', leadSourceId: sourceA.id, callAt: '2026-04-01T09:00' });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-LS1', lead: 'Qualified', invoiceNumber: 'INV-AF-LS1', saleValueExGst: 300 });
    // No Lead call at all for this one — must fall under Unassigned, never guessed.
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-LS2', lead: 'Qualified', invoiceNumber: 'INV-AF-LS2', saleValueExGst: 500 });

    const bySource = (await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&leadSourceId=${sourceA.id}`)).data;
    assert.equal(bySource.company.jobsAttended, 1);
    assert.equal(bySource.company.totalSaleExGst, 300);

    const unassigned = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&leadSourceId=unassigned')).data;
    assert.equal(unassigned.company.jobsAttended, 1);
    assert.equal(unassigned.company.totalSaleExGst, 500);
  } finally {
    server.close();
  }
});

test('Suburb resolves via the original job for a Sale, never the sale\'s own (always blank, for a non-Upsell) column', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await newJobSaleMade(server, {
      technicianId: tech.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-AF-SUB1',
      lead: 'Qualified',
      invoiceNumber: 'INV-AF-SUB1',
      saleValueExGst: 700,
      suburb: 'Norwood (5067)',
    });

    const sale = dbAll("SELECT suburb FROM sales WHERE invoice_number = 'INV-AF-SUB1'")[0];
    assert.equal(sale.suburb, '', "the sale row's own suburb column is blank, as expected for a non-Upsell");

    const data = (await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&suburb=${encodeURIComponent('Norwood (5067)')}`)).data;
    assert.equal(data.company.totalSaleExGst, 700, "the sale is still found by Suburb, resolved via its original job's suburb");
  } finally {
    server.close();
  }
});

test('Entry Type genuinely empties every other population rather than showing a misleading zero', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-ET1', lead: 'Qualified', invoiceNumber: 'INV-AF-ET1', saleValueExGst: 200 });
    await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-AF-ET1',
      visitDate: '2026-05-05',
      attendingTechnicianId: tech.id,
      creditedTechnicianId: tech.id,
      tradeId: plumbing.id,
      jobTypeId,
    });

    const data = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&entryType=call_back')).data;
    assert.deepEqual(data.includedPopulations, ['callBacksAll']);
    assert.equal(data.company.jobsAttended, 0, 'Jobs is genuinely empty, not a filtered-down count of something that still happened');
    assert.equal(data.company.totalSaleExGst, 0, 'Sales is genuinely empty too');

    const noFilter = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    assert.equal(noFilter.includedPopulations, null, 'with no Entry Type filter, every population is in play as normal');
  } finally {
    server.close();
  }
});

test('Multiple Technician & Sales Report filters combine with AND semantics', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, tech } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const electrical = bundle.trades.find((t) => t.name !== plumbing.name);

    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-AND1', lead: 'Qualified', invoiceNumber: 'INV-AF-AND1', saleValueExGst: 150 });
    // Same trade, different lead qualification — must be excluded by the combination.
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-AND2', lead: 'Not Qualified', invoiceNumber: 'INV-AF-AND2', saleValueExGst: 999 });
    // Different trade, same lead qualification — also excluded.
    if (electrical) {
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made',
        visitDate: '2026-05-01',
        technicianId: tech.id,
        jobNumber: 'JN-AF-AND3',
        tradeId: electrical.id,
        jobTypeId: electrical.jobTypes[0].id,
        lead: 'Qualified',
        invoiceNumber: 'INV-AF-AND3',
        invoiceDate: '2026-05-01',
        saleValueExGst: 999,
      });
    }

    const data = (
      await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&tradeId=${plumbing.id}&leadQualification=Qualified`)
    ).data;
    assert.equal(data.company.jobsAttended, 1);
    assert.equal(data.company.totalSaleExGst, 150);
  } finally {
    server.close();
  }
});

test('Reading the Technician & Sales Report with the new filters never mutates any job, sale or call record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    await logLeadCall(server, { jobNumber: 'JN-AF-NOMUT', leadSourceId: sourceA.id, callAt: '2026-04-01T09:00' });
    await newJobSaleMade(server, { technicianId: tech.id, plumbing, jobTypeId, jobNumber: 'JN-AF-NOMUT', lead: 'Qualified', invoiceNumber: 'INV-AF-NOMUT', saleValueExGst: 250 });

    const before = { calls: dbAll('SELECT * FROM calls ORDER BY id'), jobs: dbAll('SELECT * FROM jobs ORDER BY id'), sales: dbAll('SELECT * FROM sales ORDER BY id') };

    await server.request(
      'GET',
      `/reports/tech?from=2026-05-01&to=2026-05-31&leadQualification=Qualified&leadSourceId=${sourceA.id}&suburb=Norwood&entryType=new_job_sale_made`
    );
    await server.request('GET', '/reports/tech.xlsx?from=2026-05-01&to=2026-05-31&leadQualification=Qualified');

    const after = { calls: dbAll('SELECT * FROM calls ORDER BY id'), jobs: dbAll('SELECT * FROM jobs ORDER BY id'), sales: dbAll('SELECT * FROM sales ORDER BY id') };
    assert.deepEqual(after, before);
  } finally {
    server.close();
  }
});
