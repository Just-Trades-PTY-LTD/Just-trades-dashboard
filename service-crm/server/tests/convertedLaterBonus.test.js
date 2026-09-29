import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { mondayOf } from '../src/lib/adelaideTime.js';

// Converted Later bonus adjustment (trial) — a report-logic-only figure set
// that never touches saved jobs/sales/knockback records. See
// services/reports.js's file-level comment above computeConvertedLaterAdjustment()
// for the exact rule this verifies: each Converted Later sale (counted by
// its own invoice date) offsets one genuine qualified-no-sale "Actual
// Knockback" (counted by its own visit date) for the SAME technician within
// the SAME Monday–Sunday week, floored at zero, never crossing a technician
// or week boundary.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const techA = (await server.request('POST', '/settings/technicians', { name: 'Tech A' })).data;
  const techB = (await server.request('POST', '/settings/technicians', { name: 'Tech B' })).data;
  return { plumbing, jobTypeId, knockbackReasonId, techA, techB };
}

let jnCounter = 0;
function nextJn() {
  jnCounter += 1;
  return `JN-CLB-${jnCounter}`;
}

// A genuine Actual Knockback: a brand-new Qualified job with no sale at the
// visit.
async function knockback(server, { technicianId, visitDate, tradeId, jobTypeId, knockbackReasonId, jobNumber }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId,
    jobNumber: jobNumber || nextJn(),
    tradeId,
    jobTypeId,
    lead: 'Qualified',
    knockbackReasonId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

// A Converted Later sale credited to a technician. "Quote Approved Later"
// must reference an existing Job Number, so this creates a small, unrelated
// "Sale Made" anchor job first — deliberately NOT a knockback itself, so it
// never contaminates the Actual Knockback counts this test is verifying.
// This also proves the credit is technician+week scoped, not tied to the
// specific job number it happens to reference.
async function convertedLaterCredit(server, { creditedTechnicianId, invoiceDate, tradeId, jobTypeId, dateLogged }) {
  const anchorJn = nextJn();
  const anchor = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made',
    visitDate: invoiceDate,
    technicianId: creditedTechnicianId,
    jobNumber: anchorJn,
    tradeId,
    jobTypeId,
    lead: 'Qualified',
    invoiceNumber: `INV-ANCHOR-${anchorJn}`,
    invoiceDate,
    saleValueExGst: 100,
  });
  assert.equal(anchor.status, 201);

  // "Quote Approved Later" must match an existing Job Number — it references
  // the anchor's own JN (deliberately NOT the JN of any knockback in this
  // test), proving the credit is technician+week scoped rather than tied to
  // offsetting one specific job.
  const res = await server.request('POST', '/tech/quote-approved-later', {
    jobNumber: anchorJn,
    dateLogged: dateLogged || invoiceDate,
    creditedTechnicianId,
    invoiceNumber: `INV-CL-${anchorJn}`,
    invoiceDate,
    saleValueExGst: 250,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('No Converted Later entries: Actual Knockbacks and Adjusted Knockbacks are equal', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    const week = mondayOf('2026-03-02');
    await knockback(server, { technicianId: techA.id, visitDate: week, tradeId: plumbing.id, jobTypeId, knockbackReasonId });

    const report = (await server.request('GET', `/reports/tech?from=${week}&to=${week}`)).data;
    assert.equal(report.company.actualKnockbacks, 1);
    assert.equal(report.company.convertedLaterCredits, 0);
    assert.equal(report.company.adjustedKnockbacks, 1);
    // Existing (untouched) figures still work exactly as before.
    assert.equal(report.company.knockbacks, 1);
  } finally {
    server.close();
  }
});

test('Converted Later entered BEFORE a knockback in the same week still offsets it', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    const monday = mondayOf('2026-03-02');
    const wednesday = '2026-03-04';
    const friday = '2026-03-06';

    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: wednesday, tradeId: plumbing.id, jobTypeId });
    await knockback(server, { technicianId: techA.id, visitDate: friday, tradeId: plumbing.id, jobTypeId, knockbackReasonId });

    const report = (await server.request('GET', `/reports/tech?from=${monday}&to=2026-03-08`)).data;
    assert.equal(report.company.actualKnockbacks, 1);
    assert.equal(report.company.convertedLaterCredits, 1);
    assert.equal(report.company.adjustedKnockbacks, 0, 'the earlier credit still offsets the later knockback within the same week');
  } finally {
    server.close();
  }
});

test('Converted Later entered AFTER a knockback in the same week offsets it', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    const monday = '2026-03-02';
    const tuesday = '2026-03-03';
    const thursday = '2026-03-05';

    await knockback(server, { technicianId: techA.id, visitDate: tuesday, tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: thursday, tradeId: plumbing.id, jobTypeId });

    const report = (await server.request('GET', `/reports/tech?from=${monday}&to=2026-03-08`)).data;
    assert.equal(report.company.actualKnockbacks, 1);
    assert.equal(report.company.convertedLaterCredits, 1);
    assert.equal(report.company.adjustedKnockbacks, 0);
  } finally {
    server.close();
  }
});

test('More Converted Later entries than knockbacks floors Adjusted Knockbacks at zero (never negative)', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    const monday = '2026-03-02';

    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-04', tradeId: plumbing.id, jobTypeId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-05', tradeId: plumbing.id, jobTypeId });

    const report = (await server.request('GET', `/reports/tech?from=${monday}&to=2026-03-08`)).data;
    assert.equal(report.company.actualKnockbacks, 1);
    assert.equal(report.company.convertedLaterCredits, 2);
    assert.equal(report.company.adjustedKnockbacks, 0, 'never negative even with a surplus of credits');
  } finally {
    server.close();
  }
});

test('Zero Qualified Jobs: Conversion % is 0% and never errors', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const report = (await server.request('GET', '/reports/tech?from=2026-03-02&to=2026-03-08')).data;
    assert.equal(report.company.qualifiedJobs, 0);
    assert.equal(report.company.actualKnockbacks, 0);
    assert.equal(report.company.adjustedKnockbacks, 0);
    assert.equal(report.company.bonusConversionRate, 0);
  } finally {
    server.close();
  }
});

test('Multiple technicians: one technician\'s credit never reduces another technician\'s knockbacks', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA, techB } = await setup(server);
    const monday = '2026-03-02';

    // Tech A: 2 knockbacks, 0 credits -> adjusted stays 2.
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-04', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    // Tech B: 0 knockbacks, 1 credit -> nothing to offset, credit unused.
    await convertedLaterCredit(server, { creditedTechnicianId: techB.id, invoiceDate: '2026-03-05', tradeId: plumbing.id, jobTypeId });

    const report = (await server.request('GET', `/reports/tech?from=${monday}&to=2026-03-08`)).data;
    assert.equal(report.company.actualKnockbacks, 2);
    assert.equal(report.company.convertedLaterCredits, 1);
    // A buggy "global pool" calc would wrongly let Tech B's unused credit
    // reduce Tech A's knockbacks (2 - 1 = 1). The correct, per-technician
    // calc must keep Tech A's 2 knockbacks fully intact.
    assert.equal(report.company.adjustedKnockbacks, 2, "Tech B's credit must not reduce Tech A's knockbacks");

    const rowA = report.byTechnician.find((r) => r.name === 'Tech A');
    const rowB = report.byTechnician.find((r) => r.name === 'Tech B');
    assert.equal(rowA.actualKnockbacks, 2);
    assert.equal(rowA.adjustedKnockbacks, 2);
    assert.equal(rowB.actualKnockbacks, 0);
    assert.equal(rowB.convertedLaterCredits, 1);
    assert.equal(rowB.adjustedKnockbacks, 0);
  } finally {
    server.close();
  }
});

test('Week-boundary behaviour: an unused credit expires at the end of its week and never carries into the next week', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    // Week 1: 2026-03-02 (Mon) – 2026-03-08 (Sun). Week 2: the following week.
    const week1Monday = mondayOf('2026-03-02');
    const week2Monday = mondayOf('2026-03-09');
    assert.notEqual(week1Monday, week2Monday, 'sanity check: these really are two different weeks');

    // Week 1: 2 knockbacks + 3 credits -> only 2 credits used, adjusted = 0,
    // the 3rd credit is unused and must expire (not carry to week 2).
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-02', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-04', tradeId: plumbing.id, jobTypeId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-05', tradeId: plumbing.id, jobTypeId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-06', tradeId: plumbing.id, jobTypeId });

    // Week 2: 1 knockback, 0 credits -> adjusted = 1. If the unused week-1
    // credit wrongly carried over, this would incorrectly come out as 0.
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-10', tradeId: plumbing.id, jobTypeId, knockbackReasonId });

    const singleWeek1 = (await server.request('GET', `/reports/tech?from=${week1Monday}&to=2026-03-08`)).data;
    assert.equal(singleWeek1.company.actualKnockbacks, 2);
    assert.equal(singleWeek1.company.convertedLaterCredits, 3);
    assert.equal(singleWeek1.company.adjustedKnockbacks, 0);

    const singleWeek2 = (await server.request('GET', `/reports/tech?from=${week2Monday}&to=2026-03-15`)).data;
    assert.equal(singleWeek2.company.actualKnockbacks, 1);
    assert.equal(singleWeek2.company.convertedLaterCredits, 0);
    assert.equal(singleWeek2.company.adjustedKnockbacks, 1, "week 1's unused credit must not carry into week 2");

    // A range spanning BOTH weeks must equal the sum of each week computed
    // separately (0 + 1 = 1), never the "flatten the whole range and net
    // it" answer (actual 3 - credits 3 = 0), which would be wrong.
    const spanning = (await server.request('GET', `/reports/tech?from=${week1Monday}&to=2026-03-15`)).data;
    assert.equal(spanning.company.actualKnockbacks, 3);
    assert.equal(spanning.company.convertedLaterCredits, 3);
    assert.equal(spanning.company.adjustedKnockbacks, 1, 'each week must be settled separately before the totals are combined');
  } finally {
    server.close();
  }
});

test('Technician filter narrows the adjustment to that technician only', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA, techB } = await setup(server);
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await knockback(server, { technicianId: techB.id, visitDate: '2026-03-04', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techB.id, invoiceDate: '2026-03-05', tradeId: plumbing.id, jobTypeId });

    const filtered = (await server.request('GET', `/reports/tech?from=2026-03-02&to=2026-03-08&technicianId=${techA.id}`)).data;
    assert.equal(filtered.company.actualKnockbacks, 1);
    assert.equal(filtered.company.convertedLaterCredits, 0);
    assert.equal(filtered.company.adjustedKnockbacks, 1);
  } finally {
    server.close();
  }
});

test('Conversion % is capped at 100% and Adjusted Knockbacks never goes below zero', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-04', tradeId: plumbing.id, jobTypeId });

    const report = (await server.request('GET', '/reports/tech?from=2026-03-02&to=2026-03-08')).data;
    assert.equal(report.company.adjustedKnockbacks, 0);
    assert.equal(report.company.bonusConversionRate, 100, 'fully offset -> 100%, never more');
  } finally {
    server.close();
  }
});

test('Drill-downs: Actual Knockbacks, Converted Later and Adjusted Knockbacks each show the right records', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    // 2 knockbacks, 1 credit -> 1 used (offsets one knockback), 1 remains
    // adjusted, and a 2nd unrelated credit that's fully unused this week.
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-04', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-05', tradeId: plumbing.id, jobTypeId });

    const from = '2026-03-02';
    const to = '2026-03-08';
    const report = (await server.request('GET', `/reports/tech?from=${from}&to=${to}`)).data;
    assert.equal(report.company.actualKnockbacks, 2);
    assert.equal(report.company.convertedLaterCredits, 1);
    assert.equal(report.company.adjustedKnockbacks, 1);

    const actualDrill = (await server.request('GET', `/reports/tech/drilldown?from=${from}&to=${to}&metric=actualKnockbacks`)).data;
    assert.equal(actualDrill.count, 2);
    assert.ok(actualDrill.rows.every((r) => r.kind === 'new_job_no_sale'));

    const creditDrill = (await server.request('GET', `/reports/tech/drilldown?from=${from}&to=${to}&metric=convertedLaterCredits`)).data;
    assert.equal(creditDrill.count, 1);
    assert.ok(creditDrill.rows.every((r) => r.kind === 'quote_approved_later'));

    const adjustedDrill = (await server.request('GET', `/reports/tech/drilldown?from=${from}&to=${to}&metric=adjustedKnockbacks`)).data;
    // 2 knockback rows + 1 used-credit row = 3 rows total; the outcomes
    // explain the arithmetic explicitly.
    assert.equal(adjustedDrill.count, 3);
    assert.equal(adjustedDrill.rows.filter((r) => r.kind === 'new_job_no_sale').length, 2);
    assert.equal(adjustedDrill.rows.filter((r) => r.kind === 'quote_approved_later').length, 1);
    const outcomeByLabel = Object.fromEntries(adjustedDrill.outcomes.map((o) => [o.label, o.count]));
    assert.equal(outcomeByLabel['Actual Knockbacks'], 2);
    assert.equal(outcomeByLabel['Converted Later credits applied'], 1);
    assert.equal(outcomeByLabel['Adjusted Knockbacks'], 1);
  } finally {
    server.close();
  }
});

test('Excel export shows each metric exactly once — no duplicate Actual Knockbacks / Converted Later / Conversion % columns', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await knockback(server, { technicianId: techA.id, visitDate: '2026-03-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId });
    await convertedLaterCredit(server, { creditedTechnicianId: techA.id, invoiceDate: '2026-03-04', tradeId: plumbing.id, jobTypeId });

    const ExcelJS = (await import('exceljs')).default;
    const res = await server.rawGet('/reports/tech.xlsx?from=2026-03-02&to=2026-03-08');
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);

    function countOccurrences(text, label) {
      return (text.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    }

    // Summary: the KPI table is a "Figure | Value" list, so each label
    // should be the first cell of exactly one row.
    const summary = wb.getWorksheet('Summary');
    const summaryRows = summary.getSheetValues().filter(Boolean).map((r) => r?.[1]).filter(Boolean);
    ['Actual Knockbacks', 'Converted Later', 'Adjusted Knockbacks', 'Conversion %', 'Sales (invoices)'].forEach((label) => {
      assert.equal(summaryRows.filter((v) => v === label).length, 1, `"${label}" should appear exactly once in the Summary sheet`);
    });
    // The old, differently-scoped labels must not appear anywhere anymore —
    // they were renamed in place, not kept alongside the new ones.
    const summaryText = summaryRows.join(' | ');
    assert.equal(countOccurrences(summaryText, 'Knock backs'), 0, '"Knock backs" was renamed to "Actual Knockbacks", not duplicated');
    assert.equal(countOccurrences(summaryText, 'Conversion rate'), 0, '"Conversion rate" was renamed to "Conversion %", not duplicated');
    assert.equal(countOccurrences(summaryText, 'Converted later'), 0, 'lowercase "Converted later" must not also appear alongside "Converted Later"');

    // By technician: the header row's cells should each be unique.
    const byTechnician = wb.getWorksheet('By technician');
    const headerRow = byTechnician.getRow(byTechnician.getSheetValues().findIndex((r) => r && r.includes('Technician')));
    const headers = headerRow.values.filter(Boolean);
    console.log('By technician headers:', headers);
    ['Actual Knockbacks', 'Converted Later', 'Adjusted Knockbacks', 'Conversion %', 'Sales'].forEach((label) => {
      assert.equal(headers.filter((h) => h === label).length, 1, `"${label}" should appear exactly once as a By technician column header`);
    });
    assert.ok(!headers.includes('Knock backs'), '"Knock backs" column must not remain alongside "Actual Knockbacks"');

    // Column order: Sales -> Converted Later -> Actual Knockbacks ->
    // Adjusted Knockbacks -> Conversion %, as specified.
    const idx = (label) => headers.indexOf(label);
    assert.ok(idx('Sales') < idx('Converted Later'));
    assert.ok(idx('Converted Later') < idx('Actual Knockbacks'));
    assert.ok(idx('Actual Knockbacks') < idx('Adjusted Knockbacks'));
    assert.ok(idx('Adjusted Knockbacks') < idx('Conversion %'));
  } finally {
    server.close();
  }
});
