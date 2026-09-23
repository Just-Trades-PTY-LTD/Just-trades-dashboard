import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer } from './helpers.js';

test('calls report Excel export produces a workbook with Summary, By staff and Breakdowns tabs', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const leadSource = bundle.lists.lead_source?.[0];

    await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      leadSourceId: leadSource?.id,
      booked: 'Yes',
    });
    await server.request('POST', '/calls', {
      callAt: '2026-05-02T10:00:00',
      direction: 'Outbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      leadSourceId: leadSource?.id,
      booked: 'No',
    });

    const res = await server.rawGet('/reports/calls.xlsx?from=2026-05-01&to=2026-05-31');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="calls-report-/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, ['Summary', 'By staff', 'Breakdowns']);

    const summary = wb.getWorksheet('Summary');
    const summaryText = summary.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(summaryText, /Calls Report — Summary/);
    assert.match(summaryText, /Period: 2026-05-01/);
    assert.match(summaryText, /Total calls/);
    assert.ok(summaryText.includes(2), 'total calls value (2) should appear in the summary sheet');
    assert.match(summaryText, /Inbound calls/);
    assert.match(summaryText, /Outbound calls/);

    const byStaff = wb.getWorksheet('By staff');
    const byStaffText = byStaff.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(byStaffText, /Inbound/);
    assert.match(byStaffText, /Outbound/);

    const breakdowns = wb.getWorksheet('Breakdowns');
    const breakdownsText = breakdowns.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(breakdownsText, /Calls by trade/);
    assert.match(breakdownsText, /Plumbing/);
  } finally {
    server.close();
  }
});

test('technician & sales report Excel export produces a workbook with Summary, By trade, By technician and Charts data tabs', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Riley' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-07-01',
      technicianId: tech.id,
      jobNumber: 'JN-XL-1',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-XL-1',
      invoiceDate: '2026-07-01',
      saleValueExGst: 900,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-02',
      technicianId: tech.id,
      jobNumber: 'JN-XL-2',
      tradeId: plumbing.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const res = await server.rawGet(`/reports/tech.xlsx?from=2026-07-01&to=2026-07-31&technicianId=${tech.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, ['Summary', 'By trade', 'By technician', 'Charts data']);

    const summary = wb.getWorksheet('Summary');
    const summaryText = summary.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(summaryText, /Technician: Riley/);
    assert.match(summaryText, /Jobs attended/);

    const byTechnician = wb.getWorksheet('By technician');
    const byTechnicianText = byTechnician.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(byTechnicianText, /Riley/);
    assert.match(byTechnicianText, /Insp\. sheet/);

    const charts = wb.getWorksheet('Charts data');
    const chartsText = charts.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(chartsText, /Sale value by trade/);
  } finally {
    server.close();
  }
});
