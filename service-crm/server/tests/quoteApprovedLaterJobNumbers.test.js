import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun } from '../src/db/index.js';

// Quote Approved Later now records two separate Job Numbers:
//   - Original Job Number (job_number) — the original visit's JN, used to
//     locate/link the original job and drive technician/trade/job-type
//     attribution. Unchanged behaviour from before this feature.
//   - New Job Number (new_job_number) — the separate AroFlo JN created for
//     the approved work. Reference/search only: never linked to a job row,
//     never creates or counts as a Total/Qualified Job.
// See services techSales.js / lookup.js for the implementation.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const techA = (await server.request('POST', '/settings/technicians', { name: 'JN Tech A' })).data;
  const techB = (await server.request('POST', '/settings/technicians', { name: 'JN Tech B' })).data;
  return { bundle, plumbing, jobTypeId, knockbackReasonId, techA, techB };
}

async function originalJob(server, { technicianId, plumbing, jobTypeId, jobNumber, knockbackReasonId, visitDate = '2026-04-01', lead = 'Qualified' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead,
    knockbackReasonId: lead === 'Qualified' ? knockbackReasonId : null,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('Linking with a valid Original Job Number succeeds and auto-populates Trade and Job Type', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-LINK-1', knockbackReasonId });

    const res = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-LINK-1',
      newJobNumber: 'AROFLO-LINK-1',
      dateLogged: '2026-04-05',
      creditedTechnicianId: techA.id,
      invoiceNumber: 'INV-LINK-1',
      invoiceDate: '2026-04-05',
      saleValueExGst: 500,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.entry.tradeId, plumbing.id, 'Trade auto-populated from the matched original job');
    assert.equal(res.data.entry.jobTypeId, jobTypeId, 'Job Type auto-populated from the matched original job');
  } finally {
    server.close();
  }
});

test('An incorrect Job Number, and a partial/substring match, are both rejected — nothing is created', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-104320', knockbackReasonId });

    const wrong = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-WRONG-NUMBER',
      newJobNumber: 'AROFLO-WRONG',
      dateLogged: '2026-04-05',
      invoiceNumber: 'INV-WRONG',
      invoiceDate: '2026-04-05',
      saleValueExGst: 100,
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.data.error, /No existing job found/);

    // A partial/substring of a real Job Number must never fuzzy-match.
    const partial = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: '10432',
      newJobNumber: 'AROFLO-PARTIAL',
      dateLogged: '2026-04-05',
      invoiceNumber: 'INV-PARTIAL',
      invoiceDate: '2026-04-05',
      saleValueExGst: 100,
    });
    assert.equal(partial.status, 400);
    assert.match(partial.data.error, /No existing job found/);

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.filter((e) => e.kind === 'quote_approved_later').length, 0, 'nothing was created for either rejected attempt');
  } finally {
    server.close();
  }
});

test('Both Original and New Job Number are mandatory on a new entry, named individually when missing', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const bothMissing = await server.request('POST', '/tech/quote-approved-later', { dateLogged: '2026-04-05' });
    assert.equal(bothMissing.status, 400);
    assert.match(bothMissing.data.error, /Original Job Number/);
    assert.match(bothMissing.data.error, /New Job Number/);
  } finally {
    server.close();
  }
});

test('Both Job Numbers are saved distinctly and returned on the entry — neither overwrites the other', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-BOTH-1', knockbackReasonId });

    const res = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-BOTH-1',
      newJobNumber: 'AROFLO-BOTH-1',
      dateLogged: '2026-04-06',
      creditedTechnicianId: techA.id,
      invoiceNumber: 'INV-BOTH-1',
      invoiceDate: '2026-04-06',
      saleValueExGst: 200,
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.entry.jobNumber, 'JN-BOTH-1');
    assert.equal(res.data.entry.newJobNumber, 'AROFLO-BOTH-1');
    assert.notEqual(res.data.entry.jobNumber, res.data.entry.newJobNumber);
  } finally {
    server.close();
  }
});

test('Duplicate New Job Number protection: rejected across different original jobs, but never blocks an unrelated record from reusing that JN', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-DUP-A', knockbackReasonId });
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-DUP-B', knockbackReasonId, visitDate: '2026-04-02' });

    const first = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-DUP-A',
      newJobNumber: 'AROFLO-SHARED',
      dateLogged: '2026-04-07',
      invoiceNumber: 'INV-DUP-A',
      invoiceDate: '2026-04-07',
      saleValueExGst: 150,
    });
    assert.equal(first.status, 201);

    const dupe = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-DUP-B',
      newJobNumber: 'AROFLO-SHARED',
      dateLogged: '2026-04-08',
      invoiceNumber: 'INV-DUP-B',
      invoiceDate: '2026-04-08',
      saleValueExGst: 150,
    });
    assert.equal(dupe.status, 400);
    assert.match(dupe.data.error, /AROFLO-SHARED/);
    assert.match(dupe.data.error, /already used/);

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(
      entries.filter((e) => e.kind === 'quote_approved_later' && e.newJobNumber === 'AROFLO-SHARED').length,
      1,
      'the duplicate attempt created nothing'
    );

    // The same JN, reused on a totally unrelated record, must never be
    // blocked by this check — it is scoped only to Quote Approved Later.
    const unrelatedNewJob = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-04-09',
      technicianId: techA.id,
      jobNumber: 'AROFLO-SHARED',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
    });
    assert.equal(unrelatedNewJob.status, 201, 'a brand-new job may still use that JN as its own Job Number');

    const unrelatedCallBack = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'AROFLO-SHARED',
      visitDate: '2026-04-10',
      technicianId: techA.id,
    });
    assert.equal(unrelatedCallBack.status, 201, 'a Call Back may still reference that JN');
  } finally {
    server.close();
  }
});

test('Duplicate New Job Number protection also applies when editing (adding or changing a New Job Number on an existing entry)', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-EDIT-DUP-A', knockbackReasonId });
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-EDIT-DUP-B', knockbackReasonId, visitDate: '2026-04-02' });

    const first = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-EDIT-DUP-A',
      newJobNumber: 'AROFLO-EDIT-TAKEN',
      dateLogged: '2026-04-07',
      invoiceNumber: 'INV-EDIT-DUP-A',
      invoiceDate: '2026-04-07',
      saleValueExGst: 150,
    });
    const second = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-EDIT-DUP-B',
      newJobNumber: 'AROFLO-EDIT-FREE',
      dateLogged: '2026-04-08',
      invoiceNumber: 'INV-EDIT-DUP-B',
      invoiceDate: '2026-04-08',
      saleValueExGst: 150,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    // Editing the second entry to steal the first's New Job Number is blocked.
    const patched = await server.request('PATCH', `/tech/quote-approved-later/${second.data.entry.id}`, {
      newJobNumber: 'AROFLO-EDIT-TAKEN',
    });
    assert.equal(patched.status, 400);
    assert.match(patched.data.error, /AROFLO-EDIT-TAKEN/);

    // Editing an entry to keep its OWN existing New Job Number (no real
    // change) must never be blocked by the exclude-self check.
    const patchedSelf = await server.request('PATCH', `/tech/quote-approved-later/${first.data.entry.id}`, {
      newJobNumber: 'AROFLO-EDIT-TAKEN',
      comments: 'no-op re-save',
    });
    assert.equal(patchedSelf.status, 200, 're-saving an entry with its own unchanged New Job Number is never blocked');
  } finally {
    server.close();
  }
});

test('Searching by either the Original or the New Job Number locates the same entry', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-SEARCH-1', knockbackReasonId });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SEARCH-1',
      newJobNumber: 'AROFLO-SEARCH-1',
      dateLogged: '2026-04-11',
      invoiceNumber: 'INV-SEARCH-1',
      invoiceDate: '2026-04-11',
      saleValueExGst: 220,
    });
    assert.equal(created.status, 201);
    const id = created.data.entry.id;

    const byOriginal = (await server.request('GET', '/tech/entries?jobNumber=JN-SEARCH-1')).data;
    assert.ok(byOriginal.some((e) => e.kind === 'quote_approved_later' && e.id === id), 'found by Original Job Number');

    const byNew = (await server.request('GET', '/tech/entries?jobNumber=AROFLO-SEARCH-1')).data;
    assert.ok(byNew.some((e) => e.kind === 'quote_approved_later' && e.id === id), 'found by New Job Number');

    // Case/whitespace-insensitive, matching the existing JN search convention.
    const byNewLoose = (await server.request('GET', '/tech/entries?jobNumber=%20aroflo-search-1%20')).data;
    assert.ok(byNewLoose.some((e) => e.id === id), 'search is case- and whitespace-insensitive for the New Job Number too');
  } finally {
    server.close();
  }
});

test('A legacy Quote Approved Later record with no New Job Number stays viewable and reports correctly, and can have one added later without changing its original link', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    const job = await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-LEGACY-1', knockbackReasonId });

    // Simulate a record saved before this feature existed — inserted
    // directly, exactly like real pre-existing data on disk, never created
    // through the now-guarded POST route.
    const { lastInsertRowid: saleId } = dbRun(
      `INSERT INTO sales (job_id, job_number, new_job_number, source, date_logged, credited_technician_id, trade_id, job_type_id,
        invoice_number, invoice_date, sale_value_ex_gst, comments, created_by_user_id)
       VALUES (?, ?, '', 'quote_approved_later', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.id, 'JN-LEGACY-1', '2026-04-12', techA.id, plumbing.id, jobTypeId, 'INV-LEGACY-1', '2026-04-12', 350, 'legacy record', 1]
    );

    const entries = (await server.request('GET', '/tech/entries')).data;
    const legacy = entries.find((e) => e.id === saleId && e.kind === 'quote_approved_later');
    assert.ok(legacy, 'the legacy record must still be viewable');
    assert.equal(legacy.jobNumber, 'JN-LEGACY-1', 'the existing single Job Number is treated as the Original Job Number');
    assert.equal(legacy.newJobNumber, '', 'New Job Number is blank, never invented');

    // Ordinary reporting must not be blocked or error because of the blank
    // New Job Number.
    const report = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    assert.equal(report.company.sales, 1);
    assert.equal(report.company.totalSaleExGst, 350);
    // Still exactly one Total Job / Qualified Job — the legacy sale never
    // created or duplicated a job.
    assert.equal(report.company.jobsAttended, 1);
    assert.equal(report.company.qualifiedJobs, 1);

    // Editing it to add a New Job Number must not disturb the original link.
    const patched = await server.request('PATCH', `/tech/quote-approved-later/${saleId}`, { newJobNumber: 'AROFLO-LEGACY-1' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.newJobNumber, 'AROFLO-LEGACY-1');
    assert.equal(patched.data.jobNumber, 'JN-LEGACY-1', 'the original link/JN is unchanged');

    const afterEntries = (await server.request('GET', '/tech/entries')).data;
    const afterLegacy = afterEntries.find((e) => e.id === saleId);
    assert.equal(afterLegacy.jobNumber, 'JN-LEGACY-1');
    assert.equal(afterLegacy.newJobNumber, 'AROFLO-LEGACY-1');
    // Still exactly one job — adding the New Job Number never created one.
    const reportAfter = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    assert.equal(reportAfter.company.jobsAttended, 1);
    assert.equal(reportAfter.company.qualifiedJobs, 1);
  } finally {
    server.close();
  }
});

test('Technician attribution: the credited technician is unaffected by having two Job Numbers, and an explicit override wins over the original job\'s own technician', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA, techB } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-CREDIT-1', knockbackReasonId });

    const res = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-CREDIT-1',
      newJobNumber: 'AROFLO-CREDIT-1',
      dateLogged: '2026-04-13',
      creditedTechnicianId: techB.id,
      invoiceNumber: 'INV-CREDIT-1',
      invoiceDate: '2026-04-13',
      saleValueExGst: 600,
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.entry.creditedTechnicianId, techB.id, 'an explicit credited technician overrides the original job\'s own technician');

    const report = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    const rowB = report.byTechnician.find((r) => r.name === 'JN Tech B');
    const rowA = report.byTechnician.find((r) => r.name === 'JN Tech A');
    assert.equal(rowB.sales, 1, 'the sale is credited to Tech B');
    assert.equal(rowB.totalSaleExGst, 600);
    assert.equal(rowA?.sales || 0, 0, 'Tech A (the original job\'s own technician) is not credited with this sale');
  } finally {
    server.close();
  }
});

test('Reports: a Quote Approved Later entry never increases Total Jobs or Qualified Jobs, with or without a New Job Number', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-NOJOB-1', knockbackReasonId });

    const before = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    assert.equal(before.company.jobsAttended, 1);
    assert.equal(before.company.qualifiedJobs, 1);

    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-NOJOB-1',
      newJobNumber: 'AROFLO-NOJOB-1',
      dateLogged: '2026-04-14',
      invoiceNumber: 'INV-NOJOB-1',
      invoiceDate: '2026-04-14',
      saleValueExGst: 300,
    });

    const after = (await server.request('GET', '/reports/tech?from=2026-04-01&to=2026-04-30')).data;
    assert.equal(after.company.jobsAttended, 1, 'Total Jobs is unaffected by the new AroFlo Job Number');
    assert.equal(after.company.qualifiedJobs, 1, 'Qualified Jobs is unaffected by the new AroFlo Job Number');
    assert.equal(after.company.sales, 1);
    assert.equal(after.company.totalSaleExGst, 300);
  } finally {
    server.close();
  }
});

test('Converted Later bonus adjustment still works correctly for a Quote Approved Later entry carrying two Job Numbers', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    // A genuine knock-back the same week as the credit.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-04-06',
      technicianId: techA.id,
      jobNumber: 'JN-CLB-KB-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      knockbackReasonId,
    });
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-CLB-ANCHOR', knockbackReasonId, visitDate: '2026-04-05' });

    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-CLB-ANCHOR',
      newJobNumber: 'AROFLO-CLB-1',
      dateLogged: '2026-04-07',
      creditedTechnicianId: techA.id,
      invoiceNumber: 'INV-CLB-1',
      invoiceDate: '2026-04-07',
      saleValueExGst: 400,
    });
    assert.equal(approved.status, 201);

    const report = (await server.request('GET', '/reports/tech?from=2026-04-06&to=2026-04-12')).data;
    assert.equal(report.company.actualKnockbacks, 1);
    assert.equal(report.company.convertedLaterCredits, 1);
    assert.equal(report.company.adjustedKnockbacks, 0, 'the credit still offsets the knock-back correctly with two Job Numbers recorded');
  } finally {
    server.close();
  }
});

test('Job History Excel export includes both Original and New Job Number columns and values', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-XLSX-1', knockbackReasonId });
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-XLSX-1',
      newJobNumber: 'AROFLO-XLSX-1',
      dateLogged: '2026-04-15',
      invoiceNumber: 'INV-XLSX-1',
      invoiceDate: '2026-04-15',
      saleValueExGst: 275,
    });

    const ExcelJS = (await import('exceljs')).default;
    const res = await server.rawGet('/tech/entries/export.xlsx');
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const sheet = wb.worksheets[0];
    const text = sheet.getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(text, /New job number/);
    assert.match(text, /JN-XLSX-1/);
    assert.match(text, /AROFLO-XLSX-1/);
  } finally {
    server.close();
  }
});

test('Admin activity history records a change when either Job Number is edited', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, techA } = await setup(server);
    await originalJob(server, { technicianId: techA.id, plumbing, jobTypeId, jobNumber: 'JN-AUDIT-1', knockbackReasonId });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-AUDIT-1',
      newJobNumber: 'AROFLO-AUDIT-1',
      dateLogged: '2026-04-16',
      invoiceNumber: 'INV-AUDIT-1',
      invoiceDate: '2026-04-16',
      saleValueExGst: 180,
    });
    const id = created.data.entry.id;

    const patched = await server.request('PATCH', `/tech/quote-approved-later/${id}`, { newJobNumber: 'AROFLO-AUDIT-1-CHANGED' });
    assert.equal(patched.status, 200);

    const history = (await server.request('GET', `/tech/entries/quote_approved_later/${id}/history`)).data;
    const newJnChange = history.find((h) => h.changes.new_job_number);
    assert.ok(newJnChange, 'a change to New Job Number must appear in the audit history');
    assert.deepEqual(newJnChange.changes.new_job_number, { from: 'AROFLO-AUDIT-1', to: 'AROFLO-AUDIT-1-CHANGED' });
  } finally {
    server.close();
  }
});
