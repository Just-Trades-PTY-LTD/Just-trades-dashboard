import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer } from './helpers.js';

test('Call History Excel export respects active filters and includes full notes text', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const longNote = 'A'.repeat(200) + ' — this full note must survive in the export even though the on-screen preview truncates it.';

    const inRange = (
      await server.request('POST', '/calls', {
        callAt: '2026-05-10T09:00:00',
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
        notes: longNote,
      })
    ).data;
    // Outside the date range — must be excluded from the filtered export.
    await server.request('POST', '/calls', {
      callAt: '2026-01-01T09:00:00',
      callType: 'Lead',
      tradeId: plumbing.id,
      booked: 'No',
    });
    // A different call type — must be excluded when filtering by call type.
    await server.request('POST', '/calls', {
      callAt: '2026-05-11T09:00:00',
      callType: 'Call back',
      tradeId: plumbing.id,
    });
    // Archive one row inside the range — must be excluded unless includeArchived is set.
    const archivedCall = (
      await server.request('POST', '/calls', {
        callAt: '2026-05-12T09:00:00',
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
      })
    ).data;
    await server.request('PATCH', `/calls/${archivedCall.id}/archive`, { archived: true });

    const res = await server.rawGet('/calls/export.xlsx?from=2026-05-01&to=2026-05-31&callType=Lead');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="call-history-/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.getWorksheet('Call History');
    assert.ok(sheet, 'Call History sheet should exist');
    const values = sheet.getSheetValues();
    const text = values.flat().filter(Boolean).join(' | ');

    assert.match(text, /Period: 2026-05-01/);
    assert.match(text, /Call type: Lead/);
    assert.match(text, /Include archived: No/);
    assert.match(text, /1 call exported/);
    assert.match(text, new RegExp(longNote.slice(0, 40)), 'the full, untruncated note text must appear in the export');
    assert.ok(!text.includes('…'), 'the export must not contain a truncated preview ellipsis');

    // Only the one in-range, matching, non-archived call should be present.
    const headerRowIndex = values.findIndex((r) => Array.isArray(r) && r.includes('Date/time'));
    const dataRows = values.slice(headerRowIndex + 1).filter((r) => r && r.length);
    assert.equal(dataRows.length, 1);
  } finally {
    server.close();
  }
});

test('Call History Excel export can include archived calls when requested', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const call = (
      await server.request('POST', '/calls', {
        callAt: '2026-06-01T09:00:00',
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
      })
    ).data;
    await server.request('PATCH', `/calls/${call.id}/archive`, { archived: true });

    const res = await server.rawGet('/calls/export.xlsx?from=2026-06-01&to=2026-06-30&includeArchived=true');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.getWorksheet('Call History');
    const text = sheet.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(text, /Include archived: Yes/);
    assert.match(text, /1 call exported/);
  } finally {
    server.close();
  }
});

test('Job History Excel export respects active filters and includes full comments', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Export Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const longComment = 'B'.repeat(150) + ' — full comment must appear even though Job History never previews comments on screen at all.';

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-05-05',
      technicianId: tech.id,
      jobNumber: 'JN-HX-1',
      tradeId: plumbing.id,
      invoiceNumber: 'INV-HX-1',
      invoiceDate: '2026-05-05',
      saleValueExGst: 750,
      comments: longComment,
    });
    // Outside range.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-01-05',
      technicianId: tech.id,
      jobNumber: 'JN-HX-2',
      tradeId: plumbing.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    // Different technician.
    const otherTech = (await server.request('POST', '/settings/technicians', { name: 'Someone Else' })).data;
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-05-06',
      technicianId: otherTech.id,
      jobNumber: 'JN-HX-3',
      tradeId: plumbing.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const res = await server.rawGet(`/tech/entries/export.xlsx?from=2026-05-01&to=2026-05-31&technicianId=${tech.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="technician-sales-history-/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.getWorksheet('Job History');
    assert.ok(sheet);
    const values = sheet.getSheetValues();
    const text = values.flat().filter(Boolean).join(' | ');

    assert.match(text, /Technician: Export Tech/);
    assert.match(text, /1 entry exported/);
    assert.match(text, new RegExp(longComment.slice(0, 40)));

    const headerRowIndex = values.findIndex((r) => Array.isArray(r) && r.includes('Entry type'));
    const dataRows = values.slice(headerRowIndex + 1).filter((r) => r && r.length);
    assert.equal(dataRows.length, 1);
  } finally {
    server.close();
  }
});

test('Job History Excel export filters by entry type and trade', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Filter Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');

    await server.request('POST', '/tech/call-backs', {
      visitDate: '2026-07-01',
      jobNumber: 'JN-CB-1',
      technicianId: tech.id,
      creditedTechnicianId: tech.id,
      reasonId: bundle.lists.callback_reason?.[0]?.id,
      comments: 'call back entry',
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-02',
      technicianId: tech.id,
      jobNumber: 'JN-EL-1',
      tradeId: electrical.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const res = await server.rawGet('/tech/entries/export.xlsx?from=2026-07-01&to=2026-07-31&entryType=call_back');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.getWorksheet('Job History');
    const values = sheet.getSheetValues();
    const text = values.flat().filter(Boolean).join(' | ');
    assert.match(text, /Entry type: Call Back/);
    assert.match(text, /1 entry exported/);
    assert.match(text, /call back entry/);
    assert.ok(!text.includes('JN-EL-1'));
  } finally {
    server.close();
  }
});
