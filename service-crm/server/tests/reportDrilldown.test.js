import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('Calls & Contacts drill-down: every KPI and chart figure matches its record set exactly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');
    const google = bundle.lists.lead_source.find((s) => s.name === 'Google search');
    const referral = bundle.lists.lead_source.find((s) => s.name === 'Referral');
    const notBookedReason = bundle.lists.not_booked_reason[0];
    const staff = (await server.request('GET', '/users/directory')).data;
    const admin = staff[0];

    const from = '2026-02-01';
    const to = '2026-02-28';
    const day = `${from}T09:00:00`;

    // 6 leads: 3 Plumbing/Google (2 booked, 1 not booked with a reason), 2
    // Electrical/Referral (booked), 1 Plumbing/Google not-booked (no reason).
    await server.request('POST', '/calls', { callAt: day, direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, leadSourceId: google.id, booked: 'Yes', handledByUserId: admin.id });
    await server.request('POST', '/calls', { callAt: day, direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, leadSourceId: google.id, booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: day, direction: 'Outbound', callType: 'Lead', tradeId: plumbing.id, leadSourceId: google.id, booked: 'No', notBookedReasonId: notBookedReason.id });
    await server.request('POST', '/calls', { callAt: day, direction: 'Text Message', callType: 'Lead', tradeId: electrical.id, leadSourceId: referral.id, booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: day, direction: 'Email', callType: 'Lead', tradeId: electrical.id, leadSourceId: referral.id, booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: day, direction: 'Other / N/A', callType: 'Lead', tradeId: plumbing.id, leadSourceId: google.id, booked: 'No' });

    await server.request('POST', '/calls', { callAt: day, direction: 'Inbound', callType: 'Not lead', tradeId: plumbing.id });
    await server.request('POST', '/calls', { callAt: day, direction: 'Inbound', callType: 'Quote approved' });
    await server.request('POST', '/calls', { callAt: day, direction: 'Inbound', callType: 'Call back' });
    await server.request('POST', '/calls', {
      callAt: day,
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'New Job Cancellation',
      cancellationReasonId: bundle.lists.new_job_cancellation_reason[0].id,
    });
    await server.request('POST', '/calls', {
      callAt: day,
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'Pending Cancellation',
      cancellationReasonId: bundle.lists.pending_cancellation_reason[0].id,
    });

    const report = (await server.request('GET', `/reports/calls?from=${from}&to=${to}`)).data;
    assert.equal(report.kpis.total, 11);

    async function drill(params) {
      const res = await server.request('GET', `/reports/calls/drilldown?from=${from}&to=${to}&${params}`);
      assert.equal(res.status, 200, `drilldown(${params}) should succeed: ${JSON.stringify(res.data)}`);
      return res.data;
    }

    // --- KPI cards ---
    let d = await drill('metric=total');
    assert.equal(d.count, report.kpis.total);
    d = await drill('metric=inbound');
    assert.equal(d.count, report.kpis.inboundCount);
    assert.ok(d.rows.every((r) => r.direction === 'Inbound'));
    d = await drill('metric=leads');
    assert.equal(d.count, report.kpis.leadsCount);
    assert.ok(d.rows.every((r) => r.callType === 'Lead'));
    d = await drill('metric=booked');
    assert.equal(d.count, report.kpis.bookedCount);
    assert.ok(d.rows.every((r) => r.callType === 'Lead' && r.booked === 'Yes'));
    d = await drill('metric=bookingRate');
    assert.equal(d.count, report.kpis.leadsCount, 'bookingRate drills into the Leads it was computed from');
    assert.deepEqual(
      d.outcomes.sort((a, b) => a.label.localeCompare(b.label)),
      [
        { label: 'Booked', count: report.kpis.bookedCount },
        { label: 'Not booked', count: report.kpis.leadsCount - report.kpis.bookedCount },
      ].sort((a, b) => a.label.localeCompare(b.label))
    );
    d = await drill('metric=quotesApproved');
    assert.equal(d.count, report.kpis.quotesApproved);
    d = await drill('metric=callBackRequests');
    assert.equal(d.count, report.kpis.callBackRequests);
    d = await drill('metric=newJobCancellations');
    assert.equal(d.count, report.kpis.newJobCancellations);
    d = await drill('metric=pendingCancellations');
    assert.equal(d.count, report.kpis.pendingCancellations);

    // --- Chart sections ---
    const plumbingCount = report.byTrade.find((r) => r.name === 'Plumbing').value;
    d = await drill(`metric=byTrade&category=${encodeURIComponent('Plumbing')}`);
    assert.equal(d.count, plumbingCount);
    assert.ok(d.rows.every((r) => r.tradeName === 'Plumbing'));

    const googleCount = report.bySourcePie.find((r) => r.name === 'Google search').value;
    d = await drill(`metric=bySource&category=${encodeURIComponent('Google search')}`);
    assert.equal(d.count, googleCount);
    assert.ok(d.rows.every((r) => r.callType === 'Lead' && r.leadSourceName === 'Google search'));

    const stackRow = report.bySourceStack.find((r) => r.name === 'Google search');
    d = await drill(`metric=bySourceStack&category=${encodeURIComponent('Google search')}&segment=Booked`);
    assert.equal(d.count, stackRow.Booked);
    d = await drill(`metric=bySourceStack&category=${encodeURIComponent('Google search')}&segment=${encodeURIComponent('Not booked')}`);
    assert.equal(d.count, stackRow['Not booked']);

    const reasonRow = report.notBookedReasons.find((r) => r.name === notBookedReason.name);
    d = await drill(`metric=notBookedReason&category=${encodeURIComponent(notBookedReason.name)}`);
    assert.equal(d.count, reasonRow.value);
    assert.ok(d.rows.every((r) => r.booked === 'No' && r.notBookedReasonName === notBookedReason.name));

    const newCancelReasonName = bundle.lists.new_job_cancellation_reason[0].name;
    const newCancelRow = report.newCancelReasons.find((r) => r.name === newCancelReasonName);
    d = await drill(`metric=newCancelReason&category=${encodeURIComponent(newCancelReasonName)}`);
    assert.equal(d.count, newCancelRow.value);

    const pendingCancelReasonName = bundle.lists.pending_cancellation_reason[0].name;
    const pendingCancelRow = report.pendingCancelReasons.find((r) => r.name === pendingCancelReasonName);
    d = await drill(`metric=pendingCancelReason&category=${encodeURIComponent(pendingCancelReasonName)}`);
    assert.equal(d.count, pendingCancelRow.value);

    // --- By staff table cell ---
    const staffRow = report.staffPerf.find((s) => s.name === admin.name);
    d = await drill(`metric=staff&staffName=${encodeURIComponent(admin.name)}&field=total`);
    assert.equal(d.count, staffRow.total);
    assert.ok(d.rows.every((r) => r.handledByName === admin.name));

    // An unrecognised metric is rejected, not silently answered.
    const bad = await server.request('GET', `/reports/calls/drilldown?from=${from}&to=${to}&metric=notARealMetric`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('Technician & Sales drill-down: every KPI, trade/technician cell and chart figure matches its record set exactly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const techA = (await server.request('POST', '/settings/technicians', { name: 'Alex Plumber' })).data;
    const techB = (await server.request('POST', '/settings/technicians', { name: 'Bailey Sparky' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');
    const from = '2026-03-01';
    const to = '2026-03-31';

    // Alex/Plumbing: sale made, knock-back, converted-later, unqualified.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-03-02', technicianId: techA.id, jobNumber: 'JN-D1',
      tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified',
      invoiceNumber: 'INV-D1', invoiceDate: '2026-03-02', saleValueExGst: 500,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-03-03', technicianId: techA.id, jobNumber: 'JN-D2',
      tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    const converted = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-03-04', technicianId: techA.id, jobNumber: 'JN-D3',
      tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    assert.equal(converted.status, 201);
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-D3', dateLogged: '2026-03-10', creditedTechnicianId: techA.id,
      invoiceNumber: 'INV-D3', invoiceDate: '2026-03-10', saleValueExGst: 300,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-03-05', technicianId: techA.id, jobNumber: 'JN-D4',
      tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Not Qualified',
    });
    await server.request('POST', '/tech/call-backs', { jobNumber: 'JN-D1', visitDate: '2026-03-06', technicianId: techA.id, tradeId: plumbing.id });

    // Bailey/Electrical: sale made, pending cancellation on that same sale's JN.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-03-08', technicianId: techB.id, jobNumber: 'JN-D5',
      tradeId: electrical.id, jobTypeId: electrical.jobTypes[0].id, lead: 'Qualified',
      invoiceNumber: 'INV-D5', invoiceDate: '2026-03-08', saleValueExGst: 700,
    });
    await server.request('POST', '/tech/pending-cancellations', { jobNumber: 'JN-D5', dateLogged: '2026-03-15', creditedTechnicianId: techB.id, reasonId: bundle.lists.pending_cancellation_reason[0].id });

    const report = (await server.request('GET', `/reports/tech?from=${from}&to=${to}`)).data;
    assert.equal(report.company.jobsAttended, 5);
    assert.equal(report.company.knockbacks, 1);
    assert.equal(report.company.convertedLaterCount, 1);
    assert.equal(report.company.sales, 3);

    async function drill(params) {
      const res = await server.request('GET', `/reports/tech/drilldown?from=${from}&to=${to}&${params}`);
      assert.equal(res.status, 200, `drilldown(${params}) should succeed: ${JSON.stringify(res.data)}`);
      return res.data;
    }

    // --- Company-wide KPI cards ---
    let d = await drill('metric=jobsAttended');
    assert.equal(d.count, report.company.jobsAttended);
    d = await drill('metric=qualifiedJobs');
    assert.equal(d.count, report.company.qualifiedJobs);
    d = await drill('metric=unqualifiedJobs');
    assert.equal(d.count, report.company.unqualifiedJobs);
    assert.ok(d.rows.every((r) => r.lead === 'Not Qualified'));
    d = await drill('metric=knockbacks');
    assert.equal(d.count, report.company.knockbacks);
    d = await drill('metric=convertedLaterCount');
    assert.equal(d.count, report.company.convertedLaterCount);
    d = await drill('metric=sales');
    assert.equal(d.count, report.company.sales);
    d = await drill('metric=callBacks');
    assert.equal(d.count, report.company.callBacks);
    d = await drill('metric=pendingCancellations');
    assert.equal(d.count, report.company.pendingCancellations);

    d = await drill('metric=conversionRate');
    assert.equal(d.count, report.company.qualifiedJobs, 'conversionRate drills into the Qualified Jobs it was computed from');
    const outcomeTotal = d.outcomes.reduce((s, o) => s + o.count, 0);
    assert.equal(outcomeTotal, report.company.qualifiedJobs, 'every qualified job is accounted for in exactly one outcome');
    const saleMade = d.outcomes.find((o) => o.label === 'Sale made').count;
    const convertedLater = d.outcomes.find((o) => o.label === 'Converted later').count;
    assert.equal(saleMade + convertedLater, Math.round((report.company.conversionRate / 100) * report.company.qualifiedJobs));

    // --- By trade / By technician table cells ---
    const plumbingRow = report.byTrade.find((r) => r.trade === 'Plumbing');
    d = await drill(`metric=sales&scopeTrade=${encodeURIComponent('Plumbing')}`);
    assert.equal(d.count, plumbingRow.sales);

    const alexRow = report.byTechnician.find((r) => r.name === 'Alex Plumber');
    d = await drill(`metric=knockbacks&scopeTechnician=${encodeURIComponent('Alex Plumber')}`);
    assert.equal(d.count, alexRow.knockbacks);
    d = await drill(`metric=jobsAttended&scopeTechnician=${encodeURIComponent('Alex Plumber')}`);
    assert.equal(d.count, alexRow.jobsAttended);
    assert.ok(d.rows.every((r) => r.technicianName === 'Alex Plumber' || r.creditedTechnicianName === 'Alex Plumber'));

    // --- Chart sections ---
    const salePieRow = report.salesByTradePie.find((r) => r.name === 'Plumbing');
    d = await drill(`metric=salesByTradePie&category=${encodeURIComponent('Plumbing')}`);
    assert.equal(d.count, plumbingRow.sales, 'the pie slice and the By-trade Sales cell must show the same records');
    assert.ok(salePieRow.value > 0);

    const barRow = report.jobsOppSalesByTrade.find((r) => r.name === 'Plumbing');
    d = await drill(`metric=jobsOppSalesByTrade&category=${encodeURIComponent('Plumbing')}&series=Jobs`);
    assert.equal(d.count, barRow.Jobs);
    d = await drill(`metric=jobsOppSalesByTrade&category=${encodeURIComponent('Plumbing')}&series=${encodeURIComponent('Qualified leads')}`);
    assert.equal(d.count, barRow['Qualified leads']);
    d = await drill(`metric=jobsOppSalesByTrade&category=${encodeURIComponent('Plumbing')}&series=Sales`);
    assert.equal(d.count, barRow.Sales);

    // An unrecognised metric is rejected, not silently answered.
    const bad = await server.request('GET', `/reports/tech/drilldown?from=${from}&to=${to}&metric=notARealMetric`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
