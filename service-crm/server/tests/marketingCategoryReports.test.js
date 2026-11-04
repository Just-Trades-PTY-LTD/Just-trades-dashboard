import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// Calls Report -> Leads by Marketing Category (enquiry and booking only) and
// Technician & Sales Report -> Sales by Marketing Category (the eventual
// outcome of Qualified jobs attended in the period, by visit date). See
// services/reports.js. Reporting only: nothing is ever written.

const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const NO_CALL = 'Unassigned (no booked Lead call)';

// One realistic month (May 2026) covering every case the sections must get right.
async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const electrical = b.trades.find((t) => t.name === 'Electrical');
  const [A, B] = b.lists.lead_source;
  const reason = b.lists.knockback_reason[0].id;
  const t1 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const t2 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
  const call = async (over) =>
    ok(await server.request('POST', '/calls', { direction: 'Inbound', callType: 'Lead', booked: 'Yes', tradeId: plumbing.id, ...over }));
  const job = async (kind, jobNumber, lead, over = {}) =>
    ok(
      await server.request('POST', '/tech/new-job', {
        kind,
        visitDate: '2026-05-10',
        technicianId: t1.id,
        jobNumber,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead,
        ...(lead === 'Not Qualified' ? { inspectionSheet: 'N/A', optionSheet: 'N/A' } : {}),
        knockbackReasonId: kind === 'new_job_no_sale' && lead === 'Qualified' ? reason : null,
        ...over,
      })
    ).entry;
  const sold = (jobNumber, inv, value, over = {}) =>
    job('new_job_sale_made', jobNumber, 'Qualified', { invoiceNumber: inv, invoiceDate: '2026-05-10', saleValueExGst: value, ...over });

  const c = {};
  c.L1 = await call({ callAt: '2026-05-01T09:00', leadSourceId: A.id, jobNumber: 'M-1' });
  c.L2 = await call({ callAt: '2026-05-01T10:00', leadSourceId: A.id, jobNumber: 'M-2' });
  c.L3 = await call({ callAt: '2026-05-02T09:00', leadSourceId: A.id, jobNumber: 'M-3' }); // future booking, no job yet
  c.L4 = await call({ callAt: '2026-05-02T10:00', leadSourceId: B.id, jobNumber: 'M-4' });
  c.L5 = await call({ callAt: '2026-05-03T09:00', leadSourceId: B.id, jobNumber: 'M-5' });
  c.L6 = await call({ callAt: '2026-05-03T10:00', leadSourceId: B.id, booked: 'No', notBookedReasonId: b.lists.not_booked_reason?.[0]?.id });
  c.L7 = await call({ callAt: '2026-05-04T09:00', leadSourceId: B.id, jobNumber: 'M-6' }); // booked, then cancelled
  c.L8 = await call({ callAt: '2026-05-04T10:00', jobNumber: 'M-7' }); // no Lead Source
  c.L9 = await call({ callAt: '2026-05-05T09:00', leadSourceId: A.id, jobNumber: 'M-9' });
  c.L10 = await call({ callAt: '2026-05-06T09:00', leadSourceId: B.id, jobNumber: 'M-1' }); // later call, same JN, other source
  c.cancel = ok(
    await server.request('POST', '/calls', {
      callAt: '2026-05-05T11:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'New Job Cancellation', jobNumber: 'M-6',
      cancellationReasonId: b.lists.new_job_cancellation_reason?.[0]?.id,
    })
  );

  const j = {};
  j.M1 = await sold('M-1', 'INV-1', 1000); // Sale Made
  j.M2 = await job('new_job_no_sale', 'M-2', 'Qualified'); // knockback, converted later in June
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'M-2', newJobNumber: 'AF-2', dateLogged: '2026-06-03', creditedTechnicianId: t1.id, invoiceNumber: 'INV-2', invoiceDate: '2026-06-03', saleValueExGst: 900 }));
  j.M4 = await job('new_job_no_sale', 'M-4', 'Not Qualified');
  j.M5 = await job('new_job_no_sale', 'M-5', 'Qualified'); // genuine knockback
  j.M7 = await sold('M-7', 'INV-7', 500);
  j.M8 = await sold('M-8', 'INV-8', 300); // no Lead call at all
  j.M9 = await sold('M-9', 'INV-DUP', 400, { technicianId: t2.id, tradeId: electrical.id, jobTypeId: electrical.jobTypes[0].id });
  // The same invoice entered a second time against M-9: counted once.
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'M-9', newJobNumber: 'AF-9', dateLogged: '2026-05-12', creditedTechnicianId: t2.id, invoiceNumber: 'INV-DUP', invoiceDate: '2026-05-12', saleValueExGst: 400 }));
  // An Upsell on M-1: never part of this section.
  ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'M-1', invoiceNumber: 'INV-1', dateLogged: '2026-05-11', creditedTechnicianId: t2.id, invoiceDate: '2026-05-11', saleValueExGst: 200 }));
  return { A, B, t1, t2, plumbing, electrical, c, j };
}

const row = (section, category) => section.rows.find((r) => r.category === category);
const keys = (rows) => rows.map((r) => `${r.kind}:${r.id}`).sort();
const jobKey = (j) => `${j.kind}:${j.id}`;

test('Leads by Marketing Category: booking only, future bookings are booked, totals equal the report cards, drill-downs exact', async () => {
  const server = await startTestServer();
  try {
    const { A, B, c } = await seed(server);
    const before = dump();
    const data = ok(await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31'));
    const s = data.leadsByCategory;
    assert.deepEqual(row(s, A.name), { category: A.name, leads: 4, booked: 4, notBooked: 0, leadToBookingPct: 100 }, 'the future booking (M-3) is simply Booked');
    assert.deepEqual(row(s, B.name), { category: B.name, leads: 5, booked: 4, notBooked: 1, leadToBookingPct: 80 }, 'the cancelled booking is still a booking');
    assert.deepEqual(row(s, 'Unassigned'), { category: 'Unassigned', leads: 1, booked: 1, notBooked: 0, leadToBookingPct: 100 });
    assert.deepEqual(s.totals, { category: 'Total', leads: 10, booked: 9, notBooked: 1, leadToBookingPct: 90 });
    assert.equal(s.totals.leads, data.kpis.leadsCount, 'Total Leads = Leads card');
    assert.equal(s.totals.booked, data.kpis.bookedCount, 'Booked Leads = Booked card');
    assert.equal(s.totals.leadToBookingPct, data.kpis.bookingRate, 'Lead-to-Booking % = Booking rate card');
    for (const r of s.rows) assert.ok(!('converted' in r) && !('notConverted' in r) && !('totalSalesValueExGst' in r), 'no sales figures in this section');

    const drill = async (q) => ok(await server.request('GET', `/reports/calls/drilldown?from=2026-05-01&to=2026-05-31&metric=leadsByCategory&${q}`));
    const ids = (d) => d.rows.map((r) => r.id).sort((x, y) => x - y);
    const sorted = (...xs) => xs.map((x) => x.id).sort((x, y) => x - y);
    assert.deepEqual(ids(await drill(`category=${encodeURIComponent(B.name)}&field=notBooked`)), sorted(c.L6));
    assert.deepEqual(ids(await drill(`category=${encodeURIComponent(B.name)}&field=booked`)), sorted(c.L4, c.L5, c.L7, c.L10));
    assert.deepEqual(ids(await drill(`category=${encodeURIComponent(A.name)}&field=leads`)), sorted(c.L1, c.L2, c.L3, c.L9));
    const pctDrill = await drill(`category=${encodeURIComponent(B.name)}&field=leadToBookingPct`);
    assert.equal(pctDrill.count, 5);
    assert.deepEqual(pctDrill.outcomes, [{ label: 'Booked', count: 4 }, { label: 'Not booked', count: 1 }]);
    assert.equal((await drill('field=leads')).count, 10, 'Total row covers every category');
    assert.equal((await drill('field=booked')).count, 9);
    assert.ok(!(await drill('field=leads')).rows.some((r) => r.id === c.cancel.id), 'cancellation calls are not leads');

    // Filters: Lead Source + date together.
    const filtered = ok(await server.request('GET', `/reports/calls?from=2026-05-03&to=2026-05-31&leadSourceId=${B.id}`)).leadsByCategory;
    assert.deepEqual(filtered.totals, { category: 'Total', leads: 4, booked: 3, notBooked: 1, leadToBookingPct: 75 });

    // Excel: the sheet shows exactly the on-screen rows and totals.
    const res = await server.rawGet('/reports/calls.xlsx?from=2026-05-01&to=2026-05-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.getWorksheet('Leads by Category');
    const values = sheet.getSheetValues().filter(Boolean).map((r) => r.slice(1));
    const header = values.findIndex((r) => r[0] === 'Marketing Category');
    assert.deepEqual(values[header], ['Marketing Category', 'Total Leads', 'Booked Leads', 'Leads Not Booked', 'Lead-to-Booking %']);
    const body = values.slice(header + 1);
    assert.deepEqual(body, [...s.rows, s.totals].map((r) => [r.category, r.leads, r.booked, r.notBooked, `${r.leadToBookingPct}%`]));

    assert.deepEqual(dump(), before, 'reading the report and exporting it changed nothing');
  } finally {
    server.close();
  }
});

// Sales by Marketing Category: the sales INVOICED in the period, exactly the
// invoices and Upsells behind the Sales (invoices) and Total sale value cards.
const cardsOf = (data) => ({ sales: data.company.sales, value: data.company.totalSaleExGst });

test('Sales by Marketing Category: invoice-dated, the same records as the Sales and Total sale value cards, each invoice once', async () => {
  const server = await startTestServer();
  try {
    const { A, j } = await seed(server);
    const before = dump();
    const may = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    const s = may.salesByMarketingCategory;
    assert.deepEqual(row(s, A.name), { category: A.name, sales: 2, totalSalesValueExGst: 1600, averageInvoiceValue: 700 },
      'INV-1 and INV-DUP (entered twice, counted once) plus the $200 Upsell on M-1; average excludes the Upsell');
    assert.deepEqual(row(s, 'Unassigned'), { category: 'Unassigned', sales: 1, totalSalesValueExGst: 500, averageInvoiceValue: 500 }, 'booked call with no Lead Source');
    assert.deepEqual(row(s, NO_CALL), { category: NO_CALL, sales: 1, totalSalesValueExGst: 300, averageInvoiceValue: 300 }, 'no booked Lead call at all — still counted');
    assert.equal(s.rows.length, 3, 'only categories with invoices or upsells; the June Quote Approved Later is not in May');
    assert.deepEqual({ sales: s.totals.sales, value: s.totals.totalSalesValueExGst }, cardsOf(may), 'Total row = the cards');
    for (const r of s.rows) assert.deepEqual(Object.keys(r).sort(), ['averageInvoiceValue', 'category', 'sales', 'totalSalesValueExGst'], 'no visit-based columns');

    // The Quote Approved Later invoiced in June appears in June, under the original lead.
    const june = ok(await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30'));
    assert.deepEqual(june.salesByMarketingCategory.rows, [{ category: A.name, sales: 1, totalSalesValueExGst: 900, averageInvoiceValue: 900 }]);
    assert.deepEqual({ sales: june.salesByMarketingCategory.totals.sales, value: june.salesByMarketingCategory.totals.totalSalesValueExGst }, cardsOf(june));

    // Drill-downs: exactly the records summed.
    const drill = async (q) => ok(await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=salesByMarketingCategory&${q}`));
    const cardDrill = async (metric) => keys(ok(await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=${metric}`)).rows);
    assert.deepEqual(keys((await drill('field=sales')).rows), await cardDrill('sales'), 'Total Sales (invoices) = the Sales card records');
    assert.deepEqual(keys((await drill('field=totalSalesValue')).rows), await cardDrill('totalSaleExGst'), 'Total value = the Total sale value card records');
    const upsell = dbAll("SELECT id FROM sales WHERE is_upsell = 1")[0];
    const aValue = keys((await drill(`category=${encodeURIComponent(A.name)}&field=totalSalesValue`)).rows);
    assert.ok(aValue.includes(`existing_job_upsell:${upsell.id}`) && aValue.includes(jobKey(j.M1)), 'the Upsell follows its original JN');
    assert.equal((await drill(`category=${encodeURIComponent(A.name)}&field=averageInvoiceValue`)).count, 2, 'average: invoices only');
    assert.equal((await drill(`category=${encodeURIComponent(NO_CALL)}&field=sales`)).count, 1);

    // Excel: identical rows and totals.
    const res = await server.rawGet('/reports/tech.xlsx?from=2026-05-01&to=2026-05-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const values = wb.getWorksheet('Sales by Category').getSheetValues().filter(Boolean).map((r) => r.slice(1));
    const header = values.findIndex((r) => r[0] === 'Marketing Category');
    assert.deepEqual(values[header], ['Marketing Category', 'Sales (invoices)', 'Total Sales Value (ex GST)', 'Average Invoice Value (ex GST)']);
    const money = (v) => Math.round(v * 100) / 100;
    assert.deepEqual(values.slice(header + 1), [...s.rows, s.totals].map((r) => [r.category, r.sales, money(r.totalSalesValueExGst), r.averageInvoiceValue === null ? '—' : money(r.averageInvoiceValue)]));
    assert.match(values.slice(0, header).flat().join(' '), /Grouped by invoice date/);

    assert.deepEqual(dump(), before, 'reading the report and exporting it changed nothing');
  } finally {
    server.close();
  }
});

test('Sales by Marketing Category: the Total row equals the cards under every filter, and an Upsell-only category shows a dash', async () => {
  const server = await startTestServer();
  try {
    const { A, B, t1, t2, plumbing, electrical } = await seed(server);
    const filters = [
      '', `&technicianId=${t1.id}`, `&technicianId=${t2.id}`, `&tradeId=${plumbing.id}`, `&tradeId=${electrical.id}`,
      `&leadSourceId=${A.id}`, `&leadSourceId=${B.id}`, '&leadSourceId=unassigned', '&leadQualification=Qualified', '&saleMade=Yes',
      '&knockback=Yes', '&convertedLater=Yes', '&entryType=new_job_sale_made', '&entryType=quote_approved_later', '&entryType=existing_job_upsell',
      '&entryType=new_job_no_sale', '&jobNumber=M-1', `&technicianId=${t2.id}&tradeId=${electrical.id}&leadSourceId=${A.id}`,
    ];
    for (const range of ['from=2026-05-01&to=2026-05-31', 'from=2026-06-01&to=2026-06-30', '']) {
      for (const f of filters) {
        const data = ok(await server.request('GET', `/reports/tech?${range}${f}`));
        const t = data.salesByMarketingCategory.totals;
        assert.deepEqual({ sales: t.sales, value: Math.round(t.totalSalesValueExGst * 100) }, { sales: data.company.sales, value: Math.round(data.company.totalSaleExGst * 100) }, `"${range}${f}"`);
        assert.equal(data.salesByMarketingCategory.rows.reduce((n, r) => n + r.sales, 0), t.sales, 'rows add up to the total');
      }
    }
    // Upsells only: value with no invoices -> average shown as a dash.
    const upsellsOnly = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&entryType=existing_job_upsell')).salesByMarketingCategory;
    assert.deepEqual(upsellsOnly.rows, [{ category: A.name, sales: 0, totalSalesValueExGst: 200, averageInvoiceValue: null }]);
  } finally {
    server.close();
  }
});

test('Sales by Marketing Category: new work sold at a callback is Repeat customer — only when the callback link is proven', async () => {
  const server = await startTestServer();
  try {
    const { A, t1, plumbing, j } = await seed(server);
    const b = ok(await server.request('GET', '/settings/bundle'));
    const reason = b.lists.callback_reason[0].id;
    const sold = async (jobNumber, inv, value, visitDate = '2026-05-15') =>
      ok(await server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made', visitDate, technicianId: t1.id, jobNumber, tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified', invoiceNumber: inv, invoiceDate: visitDate, saleValueExGst: value,
      })).entry;
    const callbackCall = async (jobNumber, callAt) =>
      ok(await server.request('POST', '/calls', { callAt, direction: 'Inbound', callType: 'Call back', jobNumber, callBackReasonId: reason }));
    const callbackEntry = async (jobNumber, newJobNumber) =>
      ok(await server.request('POST', '/tech/call-backs', { jobNumber, newJobNumber, visitDate: '2026-05-14', technicianId: t1.id, creditedTechnicianId: t1.id, callBackReasonId: reason }));

    // 1. Proven: the Technician & Sales Call Back's NEW callback JN.
    await callbackEntry('M-1', 'CB-NEW');
    await sold('CB-NEW', 'INV-CB1', 250);
    // 2. Proven: a "Call back" call, then a sale on that JN (no Lead call, not an original JN, visited after the call).
    await callbackCall('CB-2', '2026-05-06T09:00');
    await sold('CB-2', 'INV-CB2', 300, '2026-05-10');
    // Not proven -> unchanged:
    await callbackCall('CB-3', '2026-05-20T09:00'); // the call came AFTER the sale
    await sold('CB-3', 'INV-CB3', 111, '2026-05-10');
    await callbackEntry('CB-4', ''); // the call recorded the Call Back's ORIGINAL JN
    await callbackCall('CB-4', '2026-05-06T09:00');
    await sold('CB-4', 'INV-CB4', 222, '2026-05-12');
    await callbackCall('M-1', '2026-05-07T09:00'); // the original job (booked Lead call A) keeps its source
    await callbackCall('M-7', '2026-05-07T09:00'); // the original job has a booked Lead call with no source -> stays Unassigned

    const before = dump();
    const data = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    const s = data.salesByMarketingCategory;
    assert.deepEqual(row(s, 'Repeat customer'), { category: 'Repeat customer', sales: 2, totalSalesValueExGst: 550, averageInvoiceValue: 275 }, 'INV-CB1 and INV-CB2 only');
    assert.deepEqual(row(s, A.name), { category: A.name, sales: 2, totalSalesValueExGst: 1600, averageInvoiceValue: 700 }, "the original job's sale (and its Upsell) keep their category");
    assert.deepEqual(row(s, NO_CALL), { category: NO_CALL, sales: 3, totalSalesValueExGst: 300 + 111 + 222, averageInvoiceValue: 211 }, 'unproven callback links stay Unassigned');
    assert.equal(row(s, 'Unassigned').sales, 1, 'M-7 (booked Lead call, no source) unchanged');
    assert.deepEqual({ sales: s.totals.sales, value: s.totals.totalSalesValueExGst }, cardsOf(data), 'Total row still equals the cards');

    const drill = ok(await server.request('GET', '/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=salesByMarketingCategory&category=Repeat%20customer&field=sales'));
    const cbSales = dbAll("SELECT job_id FROM sales WHERE invoice_number IN ('INV-CB1', 'INV-CB2')").map((r) => `new_job_sale_made:${r.job_id}`).sort();
    assert.deepEqual(keys(drill.rows), cbSales, 'drill-down: exactly the two callback sales');

    const res = await server.rawGet('/reports/tech.xlsx?from=2026-05-01&to=2026-05-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const values = wb.getWorksheet('Sales by Category').getSheetValues().filter(Boolean).map((r) => r.slice(1));
    assert.deepEqual(values.find((r) => r[0] === 'Repeat customer'), ['Repeat customer', 2, 550, 275], 'Excel: the same');

    // A Call Back on its own is never a sale, and the Calls Report's lead figures are untouched.
    const calls = ok(await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31'));
    assert.equal(calls.leadsByCategory.totals.leads, calls.kpis.leadsCount);
    assert.equal(j.M1.jobNumber, 'M-1');
    assert.deepEqual(dump(), before, 'reporting only — nothing changed');
  } finally {
    server.close();
  }
});
