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

test('Sales by Marketing Category: attended Qualified jobs only, outcomes once each, totals reconcile with the report', async () => {
  const server = await startTestServer();
  try {
    const { A, B, j } = await seed(server);
    const before = dump();
    const data = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    const s = data.salesByMarketingCategory;
    assert.deepEqual(row(s, A.name), {
      category: A.name, attendedQualified: 3, saleMade: 2, convertedLater: 1, sales: 3, knockbacks: 0, conversionPct: 100,
      totalSalesValueExGst: 2300, averageSaleValue: 2300 / 3,
    }, 'M-1 + M-9 sold at the visit, M-2 converted later (its June invoice counts towards May); duplicate invoice once; Upsell excluded');
    assert.deepEqual(row(s, B.name), {
      category: B.name, attendedQualified: 1, saleMade: 0, convertedLater: 0, sales: 0, knockbacks: 1, conversionPct: 0,
      totalSalesValueExGst: 0, averageSaleValue: null,
    }, 'only the genuine knockback (M-5): Not Qualified M-4, the cancelled booking and the unbooked call never count');
    assert.equal(row(s, 'Unassigned').sales, 1);
    assert.deepEqual(row(s, NO_CALL), {
      category: NO_CALL, attendedQualified: 1, saleMade: 1, convertedLater: 0, sales: 1, knockbacks: 0, conversionPct: 100,
      totalSalesValueExGst: 300, averageSaleValue: 300,
    }, 'a job with no booked Lead call stays visible');
    assert.equal(s.rows.length, 4, 'no row for the future booking (M-3) or anything not attended');

    const k = data.company;
    const t = s.totals;
    assert.equal(t.attendedQualified, k.qualifiedJobs, '= Qualified Jobs');
    assert.equal(t.knockbacks, k.knockbacks, '= Knock backs');
    assert.equal(t.convertedLater, k.convertedLaterCount, '= Converted later');
    assert.equal(t.conversionPct, k.conversionRate, '= Conversion Rate');
    assert.equal(t.sales, t.saleMade + t.convertedLater);
    assert.equal(t.attendedQualified, t.saleMade + t.convertedLater + t.knockbacks, 'every job exactly once');
    assert.equal(t.totalSalesValueExGst, 1000 + 900 + 400 + 500 + 300);

    // Drill-downs: exactly the records behind each figure.
    const drill = async (q) => ok(await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=salesByMarketingCategory&${q}`));
    const A_ = `category=${encodeURIComponent(A.name)}`;
    assert.deepEqual(keys((await drill(`${A_}&field=attendedQualified`)).rows), [jobKey(j.M1), jobKey(j.M2), jobKey(j.M9)].sort());
    assert.deepEqual(keys((await drill(`${A_}&field=convertedLater`)).rows), [jobKey(j.M2)]);
    assert.deepEqual(keys((await drill(`${A_}&field=saleMade`)).rows), [jobKey(j.M1), jobKey(j.M9)].sort());
    assert.deepEqual(keys((await drill(`category=${encodeURIComponent(B.name)}&field=knockbacks`)).rows), [jobKey(j.M5)]);
    const qal = dbAll("SELECT id FROM sales WHERE invoice_number = 'INV-2'")[0];
    const dupKept = dbAll("SELECT id, source FROM sales WHERE invoice_number = 'INV-DUP' AND is_upsell = 0 ORDER BY id DESC")[0];
    const valueRows = keys((await drill(`${A_}&field=totalSalesValue`)).rows);
    const expected = [jobKey(j.M1), jobKey(j.M2), jobKey(j.M9), `quote_approved_later:${qal.id}`];
    if (dupKept.source === 'quote_approved_later') expected.push(`quote_approved_later:${dupKept.id}`);
    assert.deepEqual(valueRows, expected.sort(), 'sold jobs plus the sales summed — no Upsell');
    const conv = await drill('field=conversionPct');
    assert.equal(conv.count, t.attendedQualified);
    assert.deepEqual(conv.outcomes, [{ label: 'Sale made', count: 4 }, { label: 'Converted later', count: 1 }, { label: 'Knock back', count: 1 }]);
    assert.equal((await drill('field=sales')).count, t.sales);

    // A Quote Approved Later sale never creates an attended job in its own month.
    const june = ok(await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30')).salesByMarketingCategory;
    assert.equal(june.totals.attendedQualified, 0);
    assert.equal(june.rows.length, 0);

    // Excel: the sheet shows exactly the on-screen rows and totals.
    const res = await server.rawGet('/reports/tech.xlsx?from=2026-05-01&to=2026-05-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const values = wb.getWorksheet('Sales by Category').getSheetValues().filter(Boolean).map((r) => r.slice(1));
    const header = values.findIndex((r) => r[0] === 'Marketing Category');
    const money = (v) => Math.round(v * 100) / 100;
    assert.deepEqual(
      values.slice(header + 1),
      [...s.rows, s.totals].map((r) => [
        r.category, r.attendedQualified, r.saleMade, r.convertedLater, r.sales, r.knockbacks, `${r.conversionPct}%`,
        money(r.totalSalesValueExGst), r.averageSaleValue === null ? '—' : money(r.averageSaleValue),
      ])
    );

    assert.deepEqual(dump(), before, 'reading the report and exporting it changed nothing');
  } finally {
    server.close();
  }
});

test('Sales by Marketing Category uses the report filters together: technician, trade, lead source, advanced filters', async () => {
  const server = await startTestServer();
  try {
    const { A, t1, t2, plumbing, electrical } = await seed(server);
    const get = async (q) => ok(await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&${q}`)).salesByMarketingCategory;

    const tech1Plumbing = await get(`technicianId=${t1.id}&tradeId=${plumbing.id}&leadSourceId=${A.id}`);
    assert.deepEqual(tech1Plumbing.rows.map((r) => [r.category, r.attendedQualified, r.sales]), [[A.name, 2, 2]], 'M-1 and M-2 only');
    assert.equal(tech1Plumbing.totals.totalSalesValueExGst, 1900);

    const tech2Elec = await get(`technicianId=${t2.id}&tradeId=${electrical.id}`);
    assert.deepEqual(tech2Elec.rows.map((r) => [r.category, r.attendedQualified, r.totalSalesValueExGst]), [[A.name, 1, 400]], 'duplicate invoice still once');

    const knockbacksOnly = await get('knockback=Yes&saleMade=No&convertedLater=No');
    assert.equal(knockbacksOnly.totals.sales, 0);
    assert.equal(knockbacksOnly.totals.knockbacks, 1);

    assert.equal((await get('leadQualification=Not%20Qualified')).totals.attendedQualified, 0, 'Not Qualified jobs never appear');
    assert.equal((await get('leadSourceId=unassigned')).totals.attendedQualified, 2, 'Unassigned covers no Lead Source and no Lead call, like the filter');

    // Drill-down with the same filters returns the same records as the figure.
    const d = ok(await server.request('GET', `/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&technicianId=${t1.id}&tradeId=${plumbing.id}&leadSourceId=${A.id}&metric=salesByMarketingCategory&field=attendedQualified`));
    assert.equal(d.count, 2);
  } finally {
    server.close();
  }
});
