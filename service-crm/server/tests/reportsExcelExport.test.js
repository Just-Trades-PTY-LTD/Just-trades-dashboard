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
    assert.match(summaryText, /Total Contacts/);
    assert.ok(summaryText.includes(2), 'total calls value (2) should appear in the summary sheet');
    assert.match(summaryText, /Inbound Calls/);
    assert.match(summaryText, /Outbound Calls/);
    assert.match(summaryText, /Text Messages/);
    assert.match(summaryText, /Emails/);
    assert.match(summaryText, /Other \/ N\/A/);

    const byStaff = wb.getWorksheet('By staff');
    const byStaffText = byStaff.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(byStaffText, /Inbound Calls/);
    assert.match(byStaffText, /Outbound Calls/);
    assert.match(byStaffText, /Text Messages/);

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
      lead: 'Qualified',
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
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const res = await server.rawGet(`/reports/tech.xlsx?from=2026-07-01&to=2026-07-31&technicianId=${tech.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheetNames = wb.worksheets.map((s) => s.name);
    assert.deepEqual(sheetNames, [
      'Summary',
      'By trade',
      'By technician',
      'Charts data',
      'Knockback Reasons Summary',
      'Knockback Records',
    ]);

    const summary = wb.getWorksheet('Summary');
    const summaryText = summary.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(summaryText, /Technician: Riley/);
    assert.match(summaryText, /Total Jobs/);
    assert.match(summaryText, /Qualified Jobs/);

    const byTechnician = wb.getWorksheet('By technician');
    const byTechnicianText = byTechnician.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(byTechnicianText, /Riley/);
    assert.match(byTechnicianText, /Inspection Sheet %/);
    assert.match(byTechnicianText, /Qualified Jobs/);
    assert.match(byTechnicianText, /Unqualified Jobs/);

    const charts = wb.getWorksheet('Charts data');
    const chartsText = charts.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(chartsText, /Sale value by trade/);
  } finally {
    server.close();
  }
});

test('Knockback Reasons export sheets follow the tracker\'s own filters (independent of the report\'s own), match the tracker\'s live totals, show "Not recorded", and never include a Converted Later entry', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const jobTypeId = plumbing.jobTypes[0].id;
    const priceReason = bundle.lists.knockback_reason.find((r) => r.name === 'Price');
    const compareReason = bundle.lists.knockback_reason.find((r) => r.name === 'Wanted to compare quotes');
    const techA = (await server.request('POST', '/settings/technicians', { name: 'Export Tech A' })).data;
    const techB = (await server.request('POST', '/settings/technicians', { name: 'Export Tech B' })).data;

    // Two knock-backs for Tech A in September (what the KBR tracker will be
    // filtered to), one of which is later approved — it must keep counting
    // under its original reason, and the separate Converted Later sale must
    // never appear in the records sheet.
    const jnFlip = 'JN-XLKBR-FLIP';
    const flippedJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-09-05', technicianId: techA.id, jobNumber: jnFlip,
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId: priceReason.id,
    });
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: jnFlip, newJobNumber: 'AROFLO-XLKBR-FLIP', dateLogged: '2026-09-06',
      creditedTechnicianId: techA.id, invoiceNumber: 'INV-XLKBR-FLIP', invoiceDate: '2026-09-06', saleValueExGst: 450,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-09-10', technicianId: techA.id, jobNumber: 'JN-XLKBR-2',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId: compareReason.id,
    });
    // A legacy knock-back with no reason saved — inserted directly, as real
    // pre-existing data would be.
    const { run: dbRun } = await import('../src/db/index.js');
    dbRun(
      `INSERT INTO jobs (job_number, visit_date, technician_id, trade_id, job_type_id, lead, had_sale_at_visit, knockback, knockback_reason_id)
       VALUES (?, ?, ?, ?, ?, 'Qualified', 0, 1, NULL)`,
      ['JN-XLKBR-LEGACY', '2026-09-12', techA.id, plumbing.id, jobTypeId]
    );
    // A knock-back for a DIFFERENT technician, outside the KBR filter below —
    // must never appear in either sheet once filtered to Tech A.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-09-15', technicianId: techB.id, jobNumber: 'JN-XLKBR-OTHERTECH',
      tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId: priceReason.id,
    });

    // The KBR tracker is filtered to Tech A, September — the MAIN report's
    // own filters are deliberately left wide open (no technician, a much
    // later date range) to prove the two are read independently.
    const kbrParams = `kbrFrom=2026-09-01&kbrTo=2026-09-30&kbrTechnicianId=${techA.id}`;
    const liveReport = (await server.request('GET', `/reports/tech/knockback-reasons?from=2026-09-01&to=2026-09-30&technicianId=${techA.id}`)).data;
    assert.equal(liveReport.total, 3);

    const res = await server.rawGet(`/reports/tech.xlsx?from=2100-01-01&to=2100-01-31&${kbrParams}`);
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);

    const kbrSummarySheet = wb.getWorksheet('Knockback Reasons Summary');
    const summaryValues = kbrSummarySheet.getSheetValues();
    const summaryText = summaryValues.flat().filter(Boolean).join(' | ');
    assert.match(summaryText, /Technician: Export Tech A/, 'uses the KBR tracker\'s own technician filter, not the report\'s (which has none)');
    assert.match(summaryText, /Period: 2026-09-01/, 'uses the KBR tracker\'s own date range, not the report\'s (2100-01)');

    // Summary totals must match the live endpoint's figures exactly — read
    // via row/cell objects rather than the raw getSheetValues() array, whose
    // index alignment with column number isn't guaranteed for blank cells.
    function findRow(sheet, firstCellValue) {
      let found = null;
      sheet.eachRow((row) => {
        if (row.getCell(1).value === firstCellValue) found = row;
      });
      return found;
    }
    const priceRow = findRow(kbrSummarySheet, 'Price');
    const compareRow = findRow(kbrSummarySheet, 'Wanted to compare quotes');
    const notRecordedRow = findRow(kbrSummarySheet, 'Not recorded');
    assert.ok(priceRow, 'Price row present');
    assert.ok(compareRow, 'Wanted to compare quotes row present');
    assert.ok(notRecordedRow, '"Not recorded" row present for the legacy knock-back with no saved reason');
    const liveByName = Object.fromEntries(liveReport.byReason.map((r) => [r.name, r]));
    assert.equal(priceRow.getCell(2).value, liveByName['Price'].count);
    assert.equal(priceRow.getCell(3).value, `${liveByName['Price'].percent}%`);
    assert.equal(notRecordedRow.getCell(2).value, liveByName['Not recorded'].count);
    const totalRow = findRow(kbrSummarySheet, 'Total');
    assert.equal(totalRow.getCell(2).value, liveReport.total);
    assert.equal(liveReport.total, 3, '2 named reasons + 1 "Not recorded" — never 4, which would mean the other technician leaked in');

    const kbrRecordsSheet = wb.getWorksheet('Knockback Records');
    const recordsText = kbrRecordsSheet.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(recordsText, new RegExp(jnFlip), 'the flipped job is still counted under its original knock-back');
    assert.match(recordsText, /JN-XLKBR-2/);
    assert.match(recordsText, /JN-XLKBR-LEGACY/);
    assert.ok(!recordsText.includes('AROFLO-XLKBR-FLIP'), 'the separate Converted Later sale must never appear as its own record');
    assert.ok(!recordsText.includes('JN-XLKBR-OTHERTECH'), "the other technician's knock-back must not leak in once filtered to Tech A");
    assert.match(recordsText, /Export Tech A/);
    assert.ok(!recordsText.includes('Export Tech B'));

    // Exactly 3 data rows, matching the live total — found by locating the
    // header row (by its first cell) and counting non-blank rows after it.
    let headerRowNumber = null;
    kbrRecordsSheet.eachRow((row, rowNumber) => {
      if (row.getCell(1).value === 'Job number') headerRowNumber = rowNumber;
    });
    assert.ok(headerRowNumber, 'header row found');
    let dataRowCount = 0;
    kbrRecordsSheet.eachRow((row, rowNumber) => {
      if (rowNumber > headerRowNumber && row.getCell(1).value) dataRowCount += 1;
    });
    assert.equal(dataRowCount, 3);
  } finally {
    server.close();
  }
});
