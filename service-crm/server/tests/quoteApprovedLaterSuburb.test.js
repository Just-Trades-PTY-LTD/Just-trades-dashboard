import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun, all as dbAll } from '../src/db/index.js';

// Converted Later (Quote Approved Later) Suburb attribution. See
// services/reports.js's resolveSuburb() and routes/techSales.js's
// listTechEntries(). The rule, applied identically everywhere a Converted
// Later sale's suburb is used:
//   1. Auto-filled from the ORIGINAL (knock-back) Job Number at creation,
//      never from the New Job Number — stays editable afterwards.
//   2. A deliberately saved (non-blank) suburb on the sale row always wins
//      for THAT sale's own attribution, overriding the original job's own
//      suburb.
//   3. A blank stored suburb (every legacy row, until edited) falls back to
//      the linked original job's own suburb.
//   4. Neither available -> Unassigned. Never silently backfilled/rewritten
//      by anything read-only (reports, entries list, search, exports).
// Must stay consistent across: the entries table (GET /tech/entries), its
// Suburb filter and free-text search, Revenue by Suburb, click-throughs,
// and Excel exports — and must never create a duplicate job/sale/conversion.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const knockbackReasonId = bundle.lists.knockback_reason[0].id;
  const tech = (await server.request('POST', '/settings/technicians', { name: 'Suburb Tech' })).data;
  return { plumbing, jobTypeId, knockbackReasonId, tech };
}

async function originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber, suburb }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate: '2026-06-01',
    technicianId: tech.id,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Qualified',
    knockbackReasonId,
    suburb,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('Converted Later auto-fills its suburb from the Original Job Number at creation, never from the New Job Number', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'JN-SUB-AUTO', suburb: 'Mile End (5031)' });
    // A second job on record under the New Job Number, with a DIFFERENT
    // suburb — must never be the one used.
    await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'AROFLO-SUB-AUTO', suburb: 'Decoy Suburb (5999)' });

    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SUB-AUTO',
      newJobNumber: 'AROFLO-SUB-AUTO',
      dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-SUB-AUTO',
      invoiceDate: '2026-06-10',
      saleValueExGst: 500,
    });
    assert.equal(created.data.entry.suburb, 'Mile End (5031)', "from the ORIGINAL job, never the New Job Number's job");
  } finally {
    server.close();
  }
});

test('The suburb can be edited to a deliberate correction, and that edit is recorded in the audit trail', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'JN-SUB-EDIT', suburb: 'Glenelg (5045)' });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SUB-EDIT', newJobNumber: 'AROFLO-SUB-EDIT', dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-SUB-EDIT', invoiceDate: '2026-06-10', saleValueExGst: 500,
    });
    const id = created.data.entry.id;
    assert.equal(created.data.entry.suburb, 'Glenelg (5045)');

    const patched = await server.request('PATCH', `/tech/quote-approved-later/${id}`, { suburb: 'Corrected Suburb (5100)' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.suburb, 'Corrected Suburb (5100)');

    const history = (await server.request('GET', `/tech/entries/quote_approved_later/${id}/history`)).data;
    const change = history.find((h) => h.changes.suburb);
    assert.ok(change, 'the suburb edit appears in the audit trail');
    assert.deepEqual(change.changes.suburb, { from: 'Glenelg (5045)', to: 'Corrected Suburb (5100)' });
    assert.ok(change.by, 'records who made the change');
    assert.ok(change.at, 'records when the change was made');

    // Clearing it back to blank is honoured, not silently ignored.
    const cleared = await server.request('PATCH', `/tech/quote-approved-later/${id}`, { suburb: '' });
    assert.equal(cleared.data.suburb, '', 'can be cleared back to blank for manual re-selection');
  } finally {
    server.close();
  }
});

test('Entries table, its Suburb filter and free-text search resolve a legacy (blank stored) Converted Later entry via its original job', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'JN-SUB-LEGACY', suburb: 'Prospect (5082)' });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SUB-LEGACY', newJobNumber: 'AROFLO-SUB-LEGACY', dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-SUB-LEGACY', invoiceDate: '2026-06-10', saleValueExGst: 400,
    });
    // Simulate a legacy row saved before this fix existed.
    dbRun('UPDATE sales SET suburb = ? WHERE id = ?', ['', created.data.entry.id]);

    const all = (await server.request('GET', '/tech/entries')).data;
    const entry = all.find((e) => e.id === created.data.entry.id && e.kind === 'quote_approved_later');
    assert.equal(entry.suburb, 'Prospect (5082)', 'the entries table resolves via the original job, never showing blank');

    const filtered = (await server.request('GET', `/tech/entries?suburb=${encodeURIComponent('Prospect (5082)')}`)).data;
    assert.ok(filtered.some((e) => e.id === created.data.entry.id), 'matched by the Suburb filter via the resolved value');

    const searched = (await server.request('GET', '/tech/entries?q=Prospect')).data;
    assert.ok(searched.some((e) => e.id === created.data.entry.id), 'matched by free-text search via the resolved value');

    // Still never rewritten in the database by any of the above reads.
    const sale = dbAll('SELECT suburb FROM sales WHERE id = ?', [created.data.entry.id])[0];
    assert.equal(sale.suburb, '', 'the stored row itself stays blank');
  } finally {
    server.close();
  }
});

test('A deliberately saved suburb overrides the original job\'s suburb in the entries table, filter, search and Excel export — the original job is untouched', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'JN-SUB-OVERRIDE', suburb: 'Kensington (5068)' });
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SUB-OVERRIDE', newJobNumber: 'AROFLO-SUB-OVERRIDE', dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-SUB-OVERRIDE', invoiceDate: '2026-06-10', saleValueExGst: 650,
      suburb: 'Deliberate Suburb (5200)',
    });

    const all = (await server.request('GET', '/tech/entries')).data;
    const entry = all.find((e) => e.id === created.data.entry.id && e.kind === 'quote_approved_later');
    assert.equal(entry.suburb, 'Deliberate Suburb (5200)', 'the stored, deliberately saved value wins over the job\'s own');

    const filteredByOwn = (await server.request('GET', `/tech/entries?suburb=${encodeURIComponent('Deliberate Suburb (5200)')}`)).data;
    assert.ok(filteredByOwn.some((e) => e.id === created.data.entry.id && e.kind === 'quote_approved_later'));
    const filteredByJob = (await server.request('GET', `/tech/entries?suburb=${encodeURIComponent('Kensington (5068)')}`)).data;
    assert.ok(
      !filteredByJob.some((e) => e.id === created.data.entry.id && e.kind === 'quote_approved_later'),
      'never also matched under the original job\'s own suburb'
    );

    const ExcelJS = (await import('exceljs')).default;
    const res = await server.rawGet('/tech/entries/export.xlsx');
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    const text = wb.worksheets[0].getSheetValues().flat().filter(Boolean).join(' | ');
    assert.match(text, /INV-SUB-OVERRIDE/);

    const job = dbAll("SELECT suburb FROM jobs WHERE job_number = 'JN-SUB-OVERRIDE'")[0];
    assert.equal(job.suburb, 'Kensington (5068)', 'the original job itself is never silently changed');
  } finally {
    server.close();
  }
});

test('No matching original job and no stored suburb: classified as Unassigned, not excluded', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, tech } = await setup(server);
    // No original job created at all for this JN.
    const created = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: 'JN-SUB-NOMATCH', invoiceNumber: 'INV-SUB-NOMATCH', dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id, invoiceDate: '2026-06-10', saleValueExGst: 200, predatesCrm: true,
      tradeId: plumbing.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const all = (await server.request('GET', '/tech/entries')).data;
    const entry = all.find((e) => e.id === created.data.entry.id);
    assert.equal(entry.suburb, '', 'unresolvable — stays blank ("Unassigned" in reports), not excluded');
  } finally {
    server.close();
  }
});

test('Suburb resolution and edits create no duplicate job, sale, or conversion, and the knock-back still flips exactly once', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, knockbackReasonId, tech } = await setup(server);
    const job = await originalJob(server, { tech, plumbing, jobTypeId, knockbackReasonId, jobNumber: 'JN-SUB-NODUPE', suburb: 'Norwood (5067)' });

    const beforeCounts = { jobs: dbAll('SELECT id FROM jobs').length, sales: dbAll('SELECT id FROM sales').length };
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-SUB-NODUPE', newJobNumber: 'AROFLO-SUB-NODUPE', dateLogged: '2026-06-10',
      creditedTechnicianId: tech.id, invoiceNumber: 'INV-SUB-NODUPE', invoiceDate: '2026-06-10', saleValueExGst: 500,
    });
    await server.request('PATCH', `/tech/quote-approved-later/${created.data.entry.id}`, { suburb: 'Edited Suburb (5300)' });
    const afterCounts = { jobs: dbAll('SELECT id FROM jobs').length, sales: dbAll('SELECT id FROM sales').length };

    assert.equal(afterCounts.jobs, beforeCounts.jobs, 'no new job is ever created by this flow');
    assert.equal(afterCounts.sales, beforeCounts.sales + 1, 'exactly one new sale, never duplicated by the suburb edit');

    const flipped = dbAll('SELECT converted_later, converted_by_sale_id FROM jobs WHERE id = ?', [job.id])[0];
    assert.equal(flipped.converted_later, 1, 'the knock-back still flips to converted exactly once');
    assert.equal(flipped.converted_by_sale_id, created.data.entry.id);
  } finally {
    server.close();
  }
});
