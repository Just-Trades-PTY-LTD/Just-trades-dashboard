import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// Technician & Sales Report -> Marketing Conversion by Category (jobs attended
// by visit date, the Summary's Sold Jobs / Adjusted Knockbacks / Conversion %
// rules, Converted Later credits offset by the three-step priority within the
// Summary's technician/week rule), plus the Lead Source filter following the
// same final Marketing Category attribution. Reporting only: nothing is
// ever written.

const TABLES = ['users', 'calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'reviews', 'technicians', 'list_items', 'audit_log'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const JUNE = 'from=2026-06-01&to=2026-06-30';

// June 2026 — weeks starting Mon 1 Jun and Mon 8 Jun.
async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const electrical = b.trades.find((t) => t.name === 'Electrical');
  const [A, B] = b.lists.lead_source;
  const referral = b.lists.lead_source.find((l) => l.name === 'Referral');
  const repeat = b.lists.lead_source.find((l) => l.name === 'Repeat customer');
  const reason = b.lists.knockback_reason[0].id;
  const t1 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const t2 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
  const call = (jobNumber, leadSourceId, callAt = '2026-05-20T09:00') =>
    server.request('POST', '/calls', { callAt, direction: 'Inbound', callType: 'Lead', booked: 'Yes', tradeId: plumbing.id, leadSourceId, jobNumber }).then(ok);
  const job = async (kind, jobNumber, visitDate, technicianId, over = {}) =>
    ok(
      await server.request('POST', '/tech/new-job', {
        kind,
        visitDate,
        technicianId,
        jobNumber,
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified',
        knockbackReasonId: kind === 'new_job_no_sale' ? reason : null,
        ...over,
      })
    ).entry;
  const kb = (jn, day, tech, over) => job('new_job_no_sale', jn, day, tech, over);
  const sold = (jn, day, tech, inv, over = {}) => job('new_job_sale_made', jn, day, tech, { invoiceNumber: inv, invoiceDate: day, saleValueExGst: 1000, ...over });
  const qal = async (jobNumber, invoiceDate, techId, inv) =>
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber, newJobNumber: `AF-${inv}`, dateLogged: invoiceDate, creditedTechnicianId: techId, invoiceNumber: inv, invoiceDate, saleValueExGst: 500 }));

  for (const [jn, src] of [['G-1', A], ['G-2', A], ['H-1', A], ['G-3', B], ['H-2', B], ['H-3', B], ['G-OLD', B], ['G-OLD2', referral]]) await call(jn, src.id);

  const j = {};
  // Tech One, week of 1 June: three Actual Knockbacks, three credits.
  j.G1 = await kb('G-1', '2026-06-02', t1.id);
  j.G2 = await kb('G-2', '2026-06-02', t1.id);
  j.G3 = await kb('G-3', '2026-06-03', t1.id);
  // Knockbacks from the previous week (May) whose quotes are approved in June.
  j.GOLD = await kb('G-OLD', '2026-05-25', t1.id);
  j.GOLD2 = await kb('G-OLD2', '2026-05-26', t1.id, { tradeId: electrical.id, jobTypeId: electrical.jobTypes[0].id });
  await qal('G-1', '2026-06-03', t1.id, 'Q-G1'); // step 1: its own linked job (A)
  await qal('G-OLD', '2026-06-04', t1.id, 'Q-GOLD'); // step 2: linked job not eligible -> same category (B) -> G-3
  await qal('G-OLD2', '2026-06-05', t1.id, 'Q-GOLD2'); // step 3: no Referral knockback that week -> oldest: G-2 (A)

  // Tech Two.
  j.H1 = await sold('H-1', '2026-06-02', t2.id, 'INV-H1');
  j.H2 = await kb('H-2', '2026-06-02', t2.id, { lead: 'Not Qualified', knockbackReasonId: null, inspectionSheet: 'N/A', optionSheet: 'N/A' });
  j.H3 = await kb('H-3', '2026-06-09', t2.id);
  // Callback work: a Call Back entry's NEW callback JN, and a "Call back" call JN.
  ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'G-1', newJobNumber: 'CB-1', visitDate: '2026-06-09', technicianId: t2.id, creditedTechnicianId: t2.id, callBackReasonId: b.lists.callback_reason[0].id }));
  j.CB1 = await sold('CB-1', '2026-06-10', t2.id, 'INV-CB1');
  ok(await server.request('POST', '/calls', { callAt: '2026-06-08T09:00', direction: 'Inbound', callType: 'Call back', jobNumber: 'CB-2', callBackReasonId: b.lists.callback_reason[0].id }));
  j.CB2 = await kb('CB-2', '2026-06-09', t2.id);
  // Week of 8 June, Tech Two: two knockbacks (H-3, CB-2), one credit — an
  // extra invoice on the already-sold H-1, so its linked job isn't a
  // knockback at all: no A knockback that week -> oldest: H-3 (B).
  await qal('H-1', '2026-06-10', t2.id, 'Q-H1');
  return { A, B, referral, repeat, t1, t2, plumbing, electrical, j };
}

const row = (section, category) => section.rows.find((r) => r.category === category);
const keys = (rows) => rows.map((r) => `${r.kind}:${r.id}`).sort();
const jobKeys = (...jobs) => jobs.map((x) => `${x.kind}:${x.id}`).sort();
const summaryOf = (c) => ({ jobs: c.jobsAttended, qualified: c.qualifiedJobs, convertedLater: c.convertedLaterCredits, adjusted: c.adjustedKnockbacks, conversion: c.bonusConversionRate });
const totalOf = (t) => ({ jobs: t.totalJobs, qualified: t.qualifiedJobs, convertedLater: null, adjusted: t.adjustedKnockbacks, conversion: t.conversionRate });

test('Marketing Conversion by Category: visit-date jobs, Summary definitions, three-step credit priority, exact drill-downs and Excel', async () => {
  const server = await startTestServer();
  try {
    const { A, B, j } = await seed(server);
    const before = dump();
    const data = ok(await server.request('GET', `/reports/tech?${JUNE}`));
    const m = data.marketingConversionByCategory;

    assert.deepEqual(row(m, A.name), { category: A.name, totalJobs: 3, qualifiedJobs: 3, soldJobs: 3, adjustedKnockbacks: 0, conversionRate: 100 });
    assert.deepEqual(row(m, B.name), { category: B.name, totalJobs: 3, qualifiedJobs: 2, soldJobs: 2, adjustedKnockbacks: 0, conversionRate: 100 }, 'Not Qualified H-2 is in Total Jobs only');
    assert.deepEqual(row(m, 'Repeat customer'), { category: 'Repeat customer', totalJobs: 2, qualifiedJobs: 2, soldJobs: 1, adjustedKnockbacks: 1, conversionRate: 50 }, 'CB-1 and CB-2 are callback jobs');
    assert.equal(m.rows.length, 3, 'the May knockbacks are not June jobs');
    assert.deepEqual(m.totals, { category: 'Total', totalJobs: 8, qualifiedJobs: 7, soldJobs: 6, adjustedKnockbacks: 1, conversionRate: 85.71 });

    // 1. Sold + Adjusted = Qualified on every row.
    for (const r of [...m.rows, m.totals]) assert.equal(r.soldJobs + r.adjustedKnockbacks, r.qualifiedJobs, r.category);
    // 2. Total row = the Summary.
    const c = data.company;
    assert.deepEqual({ ...totalOf(m.totals), convertedLater: c.convertedLaterCredits }, summaryOf(c));
    assert.equal(m.totals.soldJobs, c.qualifiedJobs - c.adjustedKnockbacks);
    assert.equal(c.convertedLaterCredits, 4);

    // The credits and how each was offset.
    const byInv = Object.fromEntries(m.offsets.map((o) => [o.invoiceNumber, o]));
    assert.deepEqual(Object.keys(byInv).sort(), ['Q-G1', 'Q-GOLD', 'Q-GOLD2', 'Q-H1']);
    assert.deepEqual([byInv['Q-G1'].step, byInv['Q-G1'].offsetJob.jobNumber, byInv['Q-G1'].linkedJob.jobNumber], ['linked', 'G-1', 'G-1']);
    assert.deepEqual([byInv['Q-GOLD'].step, byInv['Q-GOLD'].offsetJob.jobNumber, byInv['Q-GOLD'].linkedJob.jobNumber], ['sameCategory', 'G-3', 'G-OLD']);
    assert.deepEqual([byInv['Q-GOLD2'].step, byInv['Q-GOLD2'].offsetJob.jobNumber, byInv['Q-GOLD2'].offsetJob.category], ['otherCategory', 'G-2', A.name]);
    assert.deepEqual([byInv['Q-GOLD2'].linkedJob.jobNumber, byInv['Q-GOLD2'].linkedJob.category, byInv['Q-GOLD2'].invoiceCategory], ['G-OLD2', 'Referral', 'Referral']);
    assert.match(byInv['Q-GOLD2'].explanation, /Cross-category: the linked job JN G-OLD2 \(Referral, visited 2026-05-26\) wasn't eligible that week — offsets JN G-2/);
    assert.deepEqual([byInv['Q-H1'].step, byInv['Q-H1'].offsetJob.jobNumber, byInv['Q-H1'].linkedJob.jobNumber], ['otherCategory', 'H-3', 'H-1']);
    assert.equal(m.crossCategoryCredits, 2);
    assert.equal(m.note, "2 of 4 Converted Later credits offset a knockback in another category because their linked job wasn't eligible that week.");

    // 4. Drill-downs: exactly the jobs behind each figure.
    const drill = async (q) => ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=marketingConversionByCategory&${q}`));
    const cat = (name) => `category=${encodeURIComponent(name)}`;
    assert.deepEqual(keys((await drill(`${cat(B.name)}&field=totalJobs`)).rows), jobKeys(j.G3, j.H2, j.H3));
    assert.deepEqual(keys((await drill(`${cat(B.name)}&field=qualifiedJobs`)).rows), jobKeys(j.G3, j.H3));
    assert.deepEqual(keys((await drill(`${cat(B.name)}&field=conversionRate`)).rows), jobKeys(j.G3, j.H3));
    assert.deepEqual(keys((await drill(`${cat('Repeat customer')}&field=adjustedKnockbacks`)).rows), jobKeys(j.CB2));
    const soldA = await drill(`${cat(A.name)}&field=soldJobs`);
    assert.deepEqual(keys(soldA.rows), jobKeys(j.G1, j.G2, j.H1));
    assert.deepEqual(soldA.outcomes, [{ label: 'Sale Made at visit', count: 1 }, { label: 'Knockbacks offset by Converted Later', count: 2 }]);
    assert.deepEqual(soldA.offsets.map((o) => [o.invoiceNumber, o.stepLabel, o.offsetJob.jobNumber]), [['Q-G1', 'Linked job', 'G-1'], ['Q-GOLD2', 'Another category', 'G-2']]);
    for (const r of [...m.rows, m.totals]) {
      const q = r === m.totals ? '' : `${cat(r.category)}&`;
      for (const field of ['totalJobs', 'qualifiedJobs', 'soldJobs', 'adjustedKnockbacks']) {
        assert.equal((await drill(`${q}field=${field}`)).count, r[field], `${r.category} ${field}`);
      }
    }
    const cardKeys = async (metric) => keys(ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=${metric}`)).rows);
    assert.deepEqual(keys((await drill('field=totalJobs')).rows), await cardKeys('jobsAttended'), 'Total Jobs = the Jobs Attended card records');
    assert.deepEqual(keys((await drill('field=qualifiedJobs')).rows), await cardKeys('qualifiedJobs'));
    assert.deepEqual((await drill('field=soldJobs')).offsets.map((o) => o.saleId).sort(), ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=convertedLaterCredits`)).rows.map((r) => r.id).sort(), 'the same credits as the Converted Later card');

    // 5. Excel: identical rows, the note, and every credit with its explanation.
    const res = await server.rawGet(`/reports/tech.xlsx?${JUNE}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const values = wb.getWorksheet('Conversion by Category').getSheetValues().filter(Boolean).map((r) => r.slice(1));
    const header = values.findIndex((r) => r[0] === 'Marketing Category');
    assert.deepEqual(values[header], ['Marketing Category', 'Total Jobs', 'Qualified Jobs', 'Sold Jobs', 'Adjusted Knockbacks', 'Conversion %']);
    const body = values.slice(header + 1, header + 1 + m.rows.length + 1);
    assert.deepEqual(body, [...m.rows, m.totals].map((r) => [r.category, r.totalJobs, r.qualifiedJobs, r.soldJobs, r.adjustedKnockbacks, r.qualifiedJobs ? `${r.conversionRate}%` : '—']));
    assert.ok(values.slice(0, header).flat().includes(m.note), 'the note');
    assert.match(values.slice(0, header).flat().join(' '), /Grouped by visit date/);
    const creditHeader = values.findIndex((r) => r[0] === 'Invoice');
    const credits = values.slice(creditHeader + 1);
    assert.equal(credits.length, 4);
    const xGold2 = credits.find((r) => r[0] === 'Q-GOLD2');
    assert.deepEqual(xGold2.slice(4), ['Referral', 'JN G-OLD2 (visited 2026-05-26)', 'Referral', 'JN G-2 (visited 2026-06-02)', A.name, 'Another category', byInv['Q-GOLD2'].explanation]);

    // A period whose only credit stays in its own category, and a category with no Qualified jobs.
    const week1T1 = ok(await server.request('GET', `/reports/tech?from=2026-06-01&to=2026-06-03`)).marketingConversionByCategory;
    assert.equal(week1T1.note, 'The 1 Converted Later credit offset a knockback in its own category — none crossed categories.');
    const nq = ok(await server.request('GET', `/reports/tech?${JUNE}&leadQualification=Not Qualified`)).marketingConversionByCategory;
    assert.deepEqual(nq.rows, [{ category: B.name, totalJobs: 1, qualifiedJobs: 0, soldJobs: 0, adjustedKnockbacks: 0, conversionRate: 0 }]);

    // Sales by Marketing Category is still invoice-based and equals the cards.
    const s = data.salesByMarketingCategory;
    assert.deepEqual({ sales: s.totals.sales, value: s.totals.totalSalesValueExGst }, { sales: c.sales, value: c.totalSaleExGst });

    // 7. Viewing, drilling down and exporting changed nothing.
    assert.deepEqual(dump(), before);
  } finally {
    server.close();
  }
});

test('Marketing Conversion by Category: Total row equals the Summary, and every row reconciles, under every filter', async () => {
  const server = await startTestServer();
  try {
    const { A, B, referral, repeat, t1, t2, plumbing, electrical } = await seed(server);
    const before = dump();
    const filters = [
      '', `&technicianId=${t1.id}`, `&technicianId=${t2.id}`, `&tradeId=${plumbing.id}`, `&tradeId=${electrical.id}`,
      `&leadSourceId=${A.id}`, `&leadSourceId=${B.id}`, `&leadSourceId=${referral.id}`, `&leadSourceId=${repeat.id}`, '&leadSourceId=unassigned',
      '&leadQualification=Qualified', '&leadQualification=Not Qualified', '&saleMade=Yes', '&saleMade=No', '&knockback=Yes', '&convertedLater=Yes', '&convertedLater=No',
      '&entryType=new_job_sale_made', '&entryType=new_job_no_sale', '&entryType=quote_approved_later', '&jobNumber=G-1', '&suburb=Nowhere',
      `&technicianId=${t1.id}&leadSourceId=${A.id}`, `&technicianId=${t2.id}&tradeId=${plumbing.id}&leadSourceId=${repeat.id}`,
    ];
    for (const range of [JUNE, 'from=2026-05-01&to=2026-05-31', 'from=2026-06-08&to=2026-06-14', '']) {
      for (const f of filters) {
        const label = `"${range}${f}"`;
        const data = ok(await server.request('GET', `/reports/tech?${range}${f}`));
        const m = data.marketingConversionByCategory;
        const c = data.company;
        assert.deepEqual(
          { jobs: m.totals.totalJobs, qualified: m.totals.qualifiedJobs, adjusted: m.totals.adjustedKnockbacks, conversion: m.totals.conversionRate, credits: m.appliedCredits },
          { jobs: c.jobsAttended, qualified: c.qualifiedJobs, adjusted: c.adjustedKnockbacks, conversion: c.bonusConversionRate, credits: c.convertedLaterCredits },
          label
        );
        for (const r of [...m.rows, m.totals]) assert.equal(r.soldJobs + r.adjustedKnockbacks, r.qualifiedJobs, `${label} ${r.category}`);
        for (const field of ['totalJobs', 'qualifiedJobs', 'soldJobs', 'adjustedKnockbacks']) {
          assert.equal(m.rows.reduce((n, r) => n + r[field], 0), m.totals[field], `${label} rows add up: ${field}`);
        }
        const st = data.salesByMarketingCategory.totals;
        assert.deepEqual({ sales: st.sales, value: st.totalSalesValueExGst }, { sales: c.sales, value: c.totalSaleExGst }, `${label} sales table`);
      }
    }
    assert.deepEqual(dump(), before, 'filtering changed nothing');
  } finally {
    server.close();
  }
});

test('Lead Source filter follows the final Marketing Category: callback jobs/sales are Repeat customer across the whole report; Calls Report unchanged', async () => {
  const server = await startTestServer();
  try {
    const { A, repeat, j } = await seed(server);
    const before = dump();
    const get = (q) => server.request('GET', `/reports/tech?${JUNE}${q}`).then(ok);
    const all = await get('');
    const rep = await get(`&leadSourceId=${repeat.id}`);
    const un = await get('&leadSourceId=unassigned');

    // Repeat customer: exactly the callback job/sale rows the tables label Repeat customer.
    assert.equal(rep.company.jobsAttended, 2, 'CB-1 and CB-2');
    assert.deepEqual(rep.marketingConversionByCategory.rows.map((r) => r.category), ['Repeat customer']);
    assert.deepEqual(rep.marketingConversionByCategory.rows[0], row(all.marketingConversionByCategory, 'Repeat customer'));
    assert.deepEqual(rep.salesByMarketingCategory.rows.map((r) => [r.category, r.sales]), [['Repeat customer', 1]], 'INV-CB1');
    assert.deepEqual(rep.salesByMarketingCategory.rows[0], row(all.salesByMarketingCategory, 'Repeat customer'));
    const repJobs = ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&leadSourceId=${repeat.id}&metric=jobsAttended`));
    assert.deepEqual(keys(repJobs.rows), jobKeys(j.CB1, j.CB2), 'Summary drill-down follows the filter too');
    // Unassigned: the callback rows are no longer there.
    assert.equal(un.company.jobsAttended, 0);
    assert.equal(un.salesByMarketingCategory.totals.sales, 0);
    // A Lead Source still means its booked Lead calls.
    const a = await get(`&leadSourceId=${A.id}`);
    assert.deepEqual(a.marketingConversionByCategory.rows.map((r) => r.category), [A.name]);
    // Filtered to A, the Referral invoice's credit (Q-GOLD2) is not in the
    // report — exactly as for the Summary cards — so G-2 stays an Adjusted
    // Knockback, and the row still equals the filtered Summary.
    assert.deepEqual(a.marketingConversionByCategory.rows[0], { category: A.name, totalJobs: 3, qualifiedJobs: 3, soldJobs: 2, adjustedKnockbacks: 1, conversionRate: 66.67 });
    assert.deepEqual(summaryOf(a.company), { jobs: 3, qualified: 3, convertedLater: 1, adjusted: 1, conversion: 66.67 });

    // Excel with the filter matches the screen.
    const res = await server.rawGet(`/reports/tech.xlsx?${JUNE}&leadSourceId=${repeat.id}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const values = wb.getWorksheet('Conversion by Category').getSheetValues().filter(Boolean).map((r) => r.slice(1));
    assert.deepEqual(values.find((r) => r[0] === 'Repeat customer'), ['Repeat customer', 2, 2, 1, 1, '50%']);
    assert.deepEqual(values.find((r) => r[0] === 'Total'), ['Total', 2, 2, 1, 1, '50%']);

    // Unfiltered figures are unaffected by the filter change.
    assert.deepEqual(summaryOf(all.company), { jobs: 8, qualified: 7, convertedLater: 4, adjusted: 1, conversion: 85.71 });

    // Calls Report: its Lead Source filter reads each call's own Lead Source, as before.
    const callsAll = ok(await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-06-30`));
    const callsRepeat = ok(await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-06-30&leadSourceId=${repeat.id}`));
    assert.equal(callsRepeat.kpis.leadsCount, 0, 'no call was recorded with the Repeat customer source');
    assert.equal(callsAll.kpis.leadsCount, 8);
    assert.deepEqual(dump(), before);
  } finally {
    server.close();
  }
});

test('Marketing Conversion by Category: Admin and Staff see it; Technician accounts cannot reach it; permissions unchanged', async () => {
  const server = await startTestServer();
  try {
    const { t1 } = await seed(server);
    const admin = ok(await server.request('GET', `/reports/tech?${JUNE}`));
    const adminDrill = ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=marketingConversionByCategory&field=soldJobs`));
    ok(await server.request('POST', '/users', { name: 'Sam Staff', email: 'sam@test.local', password: 'password123', role: 'staff' }));
    const tina = ok(await server.request('POST', '/users', { name: 'Tina Tech', email: 'tina@test.local', password: 'password123', role: 'staff' }));
    ok(await server.request('POST', `/users/${tina.id}/technician-link`, { technicianId: t1.id, confirm: true }));
    const before = dump();

    server.setCookie('');
    await server.login('sam@test.local', 'password123');
    const staff = ok(await server.request('GET', `/reports/tech?${JUNE}`));
    assert.deepEqual(staff.marketingConversionByCategory, admin.marketingConversionByCategory, 'Staff: the same section');
    assert.deepEqual(ok(await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=marketingConversionByCategory&field=soldJobs`)).offsets, adminDrill.offsets);
    assert.equal((await server.rawGet(`/reports/tech.xlsx?${JUNE}`)).status, 200);
    assert.equal((await server.request('POST', '/archive/preview', { items: [], archived: true })).status, 403, 'Staff still cannot archive');

    server.setCookie('');
    await server.login('tina@test.local', 'password123');
    assert.equal((await server.request('GET', `/reports/tech?${JUNE}`)).status, 403, 'Technician: no full report');
    assert.equal((await server.request('GET', `/reports/tech/drilldown?${JUNE}&metric=marketingConversionByCategory&field=soldJobs`)).status, 403);
    assert.equal((await server.rawGet(`/reports/tech.xlsx?${JUNE}`)).status, 403);
    assert.equal((await server.request('GET', `/reports/tech?${JUNE}&leadSourceId=1`)).status, 403);
    const team = ok(await server.request('GET', `/me/team-report?${JUNE}`));
    assert.ok(!('marketingConversionByCategory' in team) && !('salesByMarketingCategory' in team), 'not in the Technician team report');
    assert.equal((await server.request('GET', `/me/performance/drilldown?${JUNE}&field=marketingConversionByCategory`)).status, 400);
    assert.deepEqual(dump(), before, 'nothing changed');
  } finally {
    server.close();
  }
});
