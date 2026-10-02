import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// "Existing Job — Upsell": a different technician adds extra work onto a
// job's EXISTING invoice. See routes/techSales.js's /existing-job-upsell
// POST/PATCH and services/reports.js's computeMetrics()/pickTechSubset() for
// the implementation. Must satisfy, in full:
//   - link to an existing job + existing invoice (never create a new job or
//     invoice)
//   - require the credited technician (the one who made the upsell)
//   - record only the additional upsell value ex GST
//   - auto-fill (but leave editable) Trade/Job Type/Suburb from the original
//     job, never Credited Technician
//   - never create another Total/Qualified Job, Knock-back, or count as
//     Converted Later; never change the original technician's own figures or
//     Adjusted Knockbacks
//   - duplicate protection keyed on Job Number + Invoice Number + Credited
//     Technician
//   - visible in both the original job's and the upselling technician's
//     history

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const techOriginal = (await server.request('POST', '/settings/technicians', { name: 'Upsell Tech Original' })).data;
  const techUpsell = (await server.request('POST', '/settings/technicians', { name: 'Upsell Tech Upseller' })).data;
  return { bundle, plumbing, jobTypeId, techOriginal, techUpsell };
}

// A New Job — Sale Made entry: the original job + its original invoice, which
// every Upsell test below links an upsell against.
async function originalJobWithSale(server, { technicianId, plumbing, jobTypeId, jobNumber, invoiceNumber, saleValueExGst, visitDate = '2026-05-01' }) {
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

test('A valid Upsell links to the existing job + invoice, auto-fills Trade/Job Type/Suburb but never Credited Technician', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-1',
      invoiceNumber: 'INV-UPS-1',
      saleValueExGst: 1000,
    });

    const res = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-1',
      invoiceNumber: 'INV-UPS-1',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      invoiceDate: '2026-05-01',
      saleValueExGst: 250,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.entry.kind, 'existing_job_upsell');
    assert.equal(res.data.entry.tradeId, plumbing.id, 'Trade auto-populated from the matched original job');
    assert.equal(res.data.entry.jobTypeId, jobTypeId, 'Job Type auto-populated from the matched original job');
    assert.equal(res.data.entry.creditedTechnicianId, techUpsell.id, 'credited to the technician who actually made the upsell');
    assert.equal(res.data.entry.saleValueExGst, 250, 'only the additional upsell value is recorded, never the full invoice value again');
  } finally {
    server.close();
  }
});

test('Job Number, Invoice Number and Credited Technician are all mandatory, named individually when missing', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const res = await server.request('POST', '/tech/existing-job-upsell', { saleValueExGst: 100 });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Job Number/);
    assert.match(res.data.error, /Invoice Number/);
    assert.match(res.data.error, /Credited Technician/);
  } finally {
    server.close();
  }
});

test('An unknown Job Number is rejected — nothing is created', async () => {
  const server = await startTestServer();
  try {
    const { techUpsell } = await setup(server);
    const res = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-DOES-NOT-EXIST',
      invoiceNumber: 'INV-ANY',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 100,
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /No existing job found/);
    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.filter((e) => e.kind === 'existing_job_upsell').length, 0);
  } finally {
    server.close();
  }
});

test('A Job Number that exists but with the wrong Invoice Number is rejected — must match an invoice already on record for that job', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-WRONGINV',
      invoiceNumber: 'INV-REAL',
      saleValueExGst: 500,
    });

    const res = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-WRONGINV',
      invoiceNumber: 'INV-FAKE',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 100,
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /No existing invoice/);
  } finally {
    server.close();
  }
});

test('Duplicate protection: same Job Number + Invoice Number + Credited Technician is rejected, but a different technician or a different invoice/date is allowed', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    const techUpsell2 = (await server.request('POST', '/settings/technicians', { name: 'Upsell Tech Two' })).data;
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-DUPE',
      invoiceNumber: 'INV-UPS-DUPE',
      saleValueExGst: 800,
    });

    const first = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-DUPE',
      invoiceNumber: 'INV-UPS-DUPE',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 150,
    });
    assert.equal(first.status, 201, JSON.stringify(first.data));

    // The exact same upsell (same job + invoice + technician) again — blocked.
    const dupe = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-DUPE',
      invoiceNumber: 'INV-UPS-DUPE',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 150,
    });
    assert.equal(dupe.status, 400);
    assert.match(dupe.data.error, /already has an Upsell logged/);

    // A different technician upselling onto the same invoice — allowed.
    const otherTech = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-DUPE',
      invoiceNumber: 'INV-UPS-DUPE',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell2.id,
      saleValueExGst: 90,
    });
    assert.equal(otherTech.status, 201, 'a different technician upselling onto the same invoice must never be blocked');

    // The same technician logging a second, separate upsell on a different
    // invoice for the same job — allowed. A second, genuine invoice added to
    // a job that already had a sale is exactly what Quote Approved Later is
    // also used for (see LogEntry.jsx) — never another New Job entry, which
    // would be rejected as a duplicate Job Number.
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-UPS-DUPE',
      newJobNumber: 'AROFLO-UPS-DUPE-2',
      dateLogged: '2026-05-02',
      creditedTechnicianId: techOriginal.id,
      invoiceNumber: 'INV-UPS-DUPE-2',
      invoiceDate: '2026-05-02',
      saleValueExGst: 400,
    });
    const secondInvoice = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-DUPE',
      invoiceNumber: 'INV-UPS-DUPE-2',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 60,
    });
    assert.equal(secondInvoice.status, 201, 'the same technician logging a genuinely separate upsell on a different invoice must never be blocked');

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.filter((e) => e.kind === 'existing_job_upsell').length, 3, 'only the exact duplicate was rejected');
  } finally {
    server.close();
  }
});

test('An Upsell never creates another Total Job, Qualified Job, Knock-back, or Converted Later credit, and never changes Adjusted Knockbacks', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-NOJOB',
      invoiceNumber: 'INV-UPS-NOJOB',
      saleValueExGst: 700,
    });

    const before = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    assert.equal(before.company.jobsAttended, 1);
    assert.equal(before.company.qualifiedJobs, 1);
    assert.equal(before.company.actualKnockbacks, 0);
    assert.equal(before.company.convertedLaterCredits, 0);
    assert.equal(before.company.adjustedKnockbacks, 0);

    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-NOJOB',
      invoiceNumber: 'INV-UPS-NOJOB',
      dateLogged: '2026-05-10',
      invoiceDate: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 300,
    });

    const after = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    assert.equal(after.company.jobsAttended, 1, 'Total Jobs unaffected by the Upsell');
    assert.equal(after.company.qualifiedJobs, 1, 'Qualified Jobs unaffected by the Upsell');
    assert.equal(after.company.actualKnockbacks, 0, 'never counted as a Knock-back');
    assert.equal(after.company.convertedLaterCredits, 0, 'never counted as Converted Later');
    assert.equal(after.company.adjustedKnockbacks, 0, 'Adjusted Knockbacks unaffected');
  } finally {
    server.close();
  }
});

test("An Upsell never changes the original technician's own Sales count, Value, or Average Sale", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-ORIGFIG',
      invoiceNumber: 'INV-UPS-ORIGFIG',
      saleValueExGst: 1000,
    });

    const before = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const originalBefore = before.byTechnician.find((r) => r.name === 'Upsell Tech Original');
    assert.equal(originalBefore.sales, 1);
    assert.equal(originalBefore.totalSaleExGst, 1000);
    assert.equal(originalBefore.avgSaleExGst, 1000);

    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-ORIGFIG',
      invoiceNumber: 'INV-UPS-ORIGFIG',
      dateLogged: '2026-05-10',
      invoiceDate: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 400,
    });

    const after = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const originalAfter = after.byTechnician.find((r) => r.name === 'Upsell Tech Original');
    assert.equal(originalAfter.sales, 1, "the original technician's Sales count is unaffected by someone else's upsell");
    assert.equal(originalAfter.totalSaleExGst, 1000, "the original technician's own Value is unaffected");
    assert.equal(originalAfter.avgSaleExGst, 1000, "the original technician's own Average Sale is unaffected");

    // Company-wide Value (ex GST) includes the upsell; Sales (invoices) does not.
    assert.equal(after.company.sales, 1, 'Sales (invoices) is unaffected by an Upsell — never a new invoice');
    assert.equal(after.company.totalSaleExGst, 1400, 'Company Value (ex GST) includes the upsell value');
  } finally {
    server.close();
  }
});

test("The upselling technician's Value (ex GST) includes the upsell, but their Average Sale and Sales count are unaffected by it", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-CREDITFIG',
      invoiceNumber: 'INV-UPS-CREDITFIG',
      saleValueExGst: 1000,
    });
    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-CREDITFIG',
      invoiceNumber: 'INV-UPS-CREDITFIG',
      dateLogged: '2026-05-10',
      invoiceDate: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 400,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data;
    const upsellerRow = report.byTechnician.find((r) => r.name === 'Upsell Tech Upseller');
    assert.ok(upsellerRow, 'the upselling technician appears in By Technician even though they attended no job of their own');
    assert.equal(upsellerRow.jobsAttended, 0, 'never treated as an attended job');
    assert.equal(upsellerRow.qualifiedJobs, 0, 'never treated as a qualified lead');
    assert.equal(upsellerRow.sales, 0, 'never counted as a Sale (invoice) of their own');
    assert.equal(upsellerRow.upsellsCount, 1);
    assert.equal(upsellerRow.upsellValueExGst, 400);
    assert.equal(upsellerRow.totalSaleExGst, 400, "Upsell value is included in the technician's overall credited Value (ex GST)");
    assert.equal(upsellerRow.avgSaleExGst, 0, 'Average Sale excludes upsell value and is scoped to qualified jobs this technician actually had (zero here)');
  } finally {
    server.close();
  }
});

test('An Upsell is visible in the history of both the original Job Number and the upselling technician', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-VISIBLE',
      invoiceNumber: 'INV-UPS-VISIBLE',
      saleValueExGst: 500,
    });
    const created = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-VISIBLE',
      invoiceNumber: 'INV-UPS-VISIBLE',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 200,
    });
    const id = created.data.entry.id;

    const byJobNumber = (await server.request('GET', '/tech/entries?jobNumber=JN-UPS-VISIBLE')).data;
    assert.ok(byJobNumber.some((e) => e.kind === 'existing_job_upsell' && e.id === id), 'visible under the original Job Number');

    const byTechnician = (await server.request('GET', `/tech/entries?technicianId=${techUpsell.id}`)).data;
    assert.ok(byTechnician.some((e) => e.kind === 'existing_job_upsell' && e.id === id), "visible under the upselling technician's own history");
  } finally {
    server.close();
  }
});

test('Editing an Upsell re-checks the invoice match and duplicate protection only when those fields actually change', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-EDIT',
      invoiceNumber: 'INV-UPS-EDIT',
      saleValueExGst: 900,
    });
    const created = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-EDIT',
      invoiceNumber: 'INV-UPS-EDIT',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 150,
    });
    const id = created.data.entry.id;

    // A no-op edit (e.g. just comments) must never be blocked.
    const noop = await server.request('PATCH', `/tech/existing-job-upsell/${id}`, { comments: 'corrected note' });
    assert.equal(noop.status, 200);

    // Changing Invoice Number to one that doesn't exist for this job is rejected.
    const badInvoice = await server.request('PATCH', `/tech/existing-job-upsell/${id}`, { invoiceNumber: 'INV-DOES-NOT-EXIST' });
    assert.equal(badInvoice.status, 400);
    assert.match(badInvoice.data.error, /No existing invoice/);

    // Raising the upsell value itself is a normal, allowed edit.
    const valueEdit = await server.request('PATCH', `/tech/existing-job-upsell/${id}`, { saleValueExGst: 175 });
    assert.equal(valueEdit.status, 200);
    assert.equal(valueEdit.data.saleValueExGst, 175);
  } finally {
    server.close();
  }
});

test('The original job and its original sale are completely unchanged by an Upsell being logged against them', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    const original = await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-UNCHANGED',
      invoiceNumber: 'INV-UPS-UNCHANGED',
      saleValueExGst: 600,
    });

    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-UNCHANGED',
      invoiceNumber: 'INV-UPS-UNCHANGED',
      dateLogged: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 220,
    });

    const entries = (await server.request('GET', '/tech/entries')).data;
    const originalAfter = entries.find((e) => e.id === original.id && e.kind === 'new_job_sale_made');
    assert.ok(originalAfter, 'the original job entry still exists, unchanged in kind');
    assert.equal(originalAfter.saleValueExGst, 600, "the original job's own sale value is untouched");
    assert.equal(originalAfter.technicianId, techOriginal.id, "the original job's own technician is untouched");
  } finally {
    server.close();
  }
});

test('Excel exports: Job History export labels the entry "Existing Job — Upsell"; Tech report export includes Upsells/Upsell Value', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techUpsell } = await setup(server);
    await originalJobWithSale(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-UPS-XLSX',
      invoiceNumber: 'INV-UPS-XLSX',
      saleValueExGst: 500,
    });
    await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-UPS-XLSX',
      invoiceNumber: 'INV-UPS-XLSX',
      dateLogged: '2026-05-10',
      invoiceDate: '2026-05-10',
      creditedTechnicianId: techUpsell.id,
      saleValueExGst: 300,
    });

    const ExcelJS = (await import('exceljs')).default;

    const historyRes = await server.rawGet('/tech/entries/export.xlsx');
    assert.equal(historyRes.status, 200);
    const historyWb = new ExcelJS.Workbook();
    await historyWb.xlsx.load(historyRes.buffer);
    const historyText = historyWb.worksheets[0].getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(historyText, /Existing Job — Upsell/);
    assert.match(historyText, /INV-UPS-XLSX/);

    const reportRes = await server.rawGet('/reports/tech.xlsx?from=2026-05-01&to=2026-05-31');
    assert.equal(reportRes.status, 200);
    const reportWb = new ExcelJS.Workbook();
    await reportWb.xlsx.load(reportRes.buffer);
    const summaryText = reportWb.worksheets.find((s) => s.name === 'Summary').getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(summaryText, /Upsells/);
    assert.match(summaryText, /Upsell value \(ex GST\)/);
    const byTechText = reportWb.worksheets.find((s) => s.name === 'By technician').getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(byTechText, /Upsells/);
  } finally {
    server.close();
  }
});
