import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, archiveEntries } from './helpers.js';
import { createApp } from '../src/app.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';

// Manual archive / unarchive with linked records (lib/archive.js,
// routes/archive.js) and edit consistency for Sale Made jobs, Quote Approved
// Later Job Numbers, Pending Cancellation calls and duplicate Job Numbers.

const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const job = (id) => dbGet('SELECT * FROM jobs WHERE id = ?', [id]);
const sale = (id) => dbGet('SELECT * FROM sales WHERE id = ?', [id]);
const visitSale = (jobId) => dbGet("SELECT * FROM sales WHERE job_id = ? AND source = 'sale_made_at_visit'", [jobId]);
const lastAudit = (entity, id) => {
  const r = dbGet('SELECT changes_json FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1', [entity, id]);
  return r ? JSON.parse(r.changes_json) : null;
};
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function setup(server) {
  await server.login();
  const b = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const electrical = b.trades.find((t) => t.name === 'Electrical');
  const tA = (await server.request('POST', '/settings/technicians', { name: 'Tech A' })).data;
  const tB = (await server.request('POST', '/settings/technicians', { name: 'Tech B' })).data;
  return { plumbing, electrical, jobTypeId: plumbing.jobTypes[0].id, L: b.lists, tA, tB };
}
const noSale = async (server, ctx, jobNumber, lead = 'Qualified') =>
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale', visitDate: '2026-05-01', technicianId: ctx.tA.id, jobNumber, tradeId: ctx.plumbing.id, jobTypeId: ctx.jobTypeId, lead,
    knockbackReasonId: lead === 'Qualified' ? ctx.L.knockback_reason[0].id : null, ...(lead === 'Not Qualified' ? { inspectionSheet: 'N/A', optionSheet: 'N/A' } : {}),
  })).entry;
const saleMade = async (server, ctx, jobNumber, invoiceNumber, value = 500) =>
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-02', technicianId: ctx.tA.id, jobNumber, tradeId: ctx.plumbing.id, jobTypeId: ctx.jobTypeId,
    lead: 'Qualified', invoiceNumber, invoiceDate: '2026-05-02', saleValueExGst: value,
  })).entry;
const qal = async (server, ctx, jobNumber, invoiceNumber, value = 900) =>
  ok(await server.request('POST', '/tech/quote-approved-later', {
    jobNumber, newJobNumber: `AF-${invoiceNumber}`, dateLogged: '2026-05-10', creditedTechnicianId: ctx.tA.id, invoiceNumber, invoiceDate: '2026-05-10', saleValueExGst: value,
  })).entry;
const report = async (server) => (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data.company;

// ---------------------------------------------------------------- archive

test('manual archive of a Sale Made job: preview names the linked sale, apply archives both and records both in Activity history', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'A-1', 'INV-A1', 1000);
    const s = visitSale(j.id);
    assert.equal((await report(server)).totalSaleExGst, 1000);

    const preview = ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_sale_made', id: j.id }], archived: true }));
    assert.deepEqual(preview.countsByType, { 'New Job — Sale Made': 1 });
    assert.equal(preview.linkedChanges.length, 1);
    assert.match(preview.linkedChanges[0], /Also archive its sale inv INV-A1 \(\$1,000 ex GST\)/);

    ok(await server.request('POST', '/archive/apply', { items: [{ kind: 'new_job_sale_made', id: j.id }], archived: true, token: preview.token }));
    assert.equal(job(j.id).archived, 1);
    assert.equal(sale(s.id).archived, 1);
    assert.equal((await report(server)).totalSaleExGst, 0, 'the sale no longer counts');
    assert.deepEqual(lastAudit('job', j.id), { archived: { from: 'No', to: 'Yes' }, linked_sale_archived: { from: null, to: s.id } });
    assert.deepEqual(lastAudit('sale', s.id), { archived: { from: 'No', to: 'Yes' }, archived_with_job: { from: null, to: j.id } });

    // Unarchive restores the sale archived with it, and records it.
    ok(await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j.id }], false));
    assert.equal(job(j.id).archived, 0);
    assert.equal(sale(s.id).archived, 0);
    assert.equal((await report(server)).totalSaleExGst, 1000);
    assert.deepEqual(lastAudit('sale', s.id), { archived: { from: 'Yes', to: 'No' }, restored_with_job: { from: null, to: j.id } });
  } finally {
    server.close();
  }
});

test('a cancelled confirmation (preview only) changes nothing', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'A-2', 'INV-A2');
    const before = dump();
    ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_sale_made', id: j.id }], archived: true }));
    assert.deepEqual(dump(), before);
  } finally {
    server.close();
  }
});

test('apply without the confirmed token, or after the records changed, changes nothing', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const kb = await noSale(server, ctx, 'A-3');
    const q = await qal(server, ctx, 'A-3', 'INV-A3');
    const items = [{ kind: 'quote_approved_later', id: q.id }];
    const preview = ok(await server.request('POST', '/archive/preview', { items, archived: true }));
    assert.match(preview.linkedChanges.join(), /Undo the "Converted later" this sale gave JN A-3/);
    const before = dump();
    assert.equal((await server.request('POST', '/archive/apply', { items, archived: true })).status, 409);
    assert.deepEqual(dump(), before, 'no token: nothing changed');
    // Something changes between preview and apply (the conversion is gone).
    dbRun('UPDATE jobs SET converted_later = 0, converted_by_sale_id = NULL WHERE id = ?', [kb.id]);
    const before2 = dump();
    const stale = await server.request('POST', '/archive/apply', { items, archived: true, token: preview.token });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /changed since you confirmed/);
    assert.deepEqual(dump(), before2);
  } finally {
    server.close();
  }
});

test('bulk archive: preview shows the number and types of records and every linked change; apply is all-or-nothing', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const sm = await saleMade(server, ctx, 'B-1', 'INV-B1');
    const ns = await noSale(server, ctx, 'B-2');
    const q = await qal(server, ctx, 'B-2', 'INV-B2');
    const call = ok(await server.request('POST', '/calls', { callAt: '2026-05-03T09:00', direction: 'Inbound', callType: 'Not lead' }));
    const items = [
      { kind: 'new_job_sale_made', id: sm.id },
      { kind: 'new_job_no_sale', id: ns.id },
      { kind: 'quote_approved_later', id: q.id },
      { kind: 'call', id: call.id },
    ];
    const preview = ok(await server.request('POST', '/archive/preview', { items, archived: true }));
    assert.equal(preview.entries, 4);
    assert.deepEqual(preview.countsByType, { 'New Job — Sale Made': 1, 'New Job — No Sale': 1, 'Quote Approved Later': 1, Call: 1 });
    assert.equal(preview.linkedChanges.length, 2, 'the Sale Made job\'s sale, and the conversion the QAL sale gave B-2');
    assert.doesNotMatch(preview.notes.join(), /converted it is not changed/, 'no "sale not changed" note when that sale is archived in the same action');
    const alone = ok(await server.request('POST', '/archive/preview', { items: [items.find((i) => i.kind === 'new_job_no_sale')], archived: true }));
    assert.match(alone.notes.join(), /converted it is not changed and still counts as a sale/, 'archiving the job alone says its converting sale is left as is');

    // One item no longer allowed (already archived) -> the whole bulk action is refused.
    dbRun('UPDATE calls SET archived = 1 WHERE id = ?', [call.id]);
    const before = dump();
    const refused = await server.request('POST', '/archive/apply', { items, archived: true, token: preview.token });
    assert.equal(refused.status, 400);
    assert.deepEqual(dump(), before, 'nothing in the batch was archived');
    dbRun('UPDATE calls SET archived = 0 WHERE id = ?', [call.id]);

    ok(await server.request('POST', '/archive/apply', { items, archived: true, token: preview.token }));
    assert.deepEqual([job(sm.id).archived, visitSale(sm.id).archived, job(ns.id).archived, sale(q.id).archived], [1, 1, 1, 1]);
    assert.equal(job(ns.id).converted_later, 0);
  } finally {
    server.close();
  }
});

test('a linked sale that was already archived on its own is never touched or restored', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    // Case 1: the sale was archived separately BEFORE the job.
    const j1 = await saleMade(server, ctx, 'C-1', 'INV-C1');
    const s1 = visitSale(j1.id);
    dbRun('UPDATE sales SET archived = 1 WHERE id = ?', [s1.id]);
    const p1 = ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_sale_made', id: j1.id }], archived: true }));
    assert.equal(p1.linkedChanges.length, 0);
    assert.match(p1.notes.join(), /already archived on its own and stays archived/);
    ok(await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j1.id }]));
    const p1b = ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_sale_made', id: j1.id }], archived: false }));
    assert.match(p1b.notes.join(), /archived separately, so it stays archived/);
    ok(await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j1.id }], false));
    assert.deepEqual([job(j1.id).archived, sale(s1.id).archived], [0, 1], 'job restored, sale stays archived');

    // Case 2: archived together, then the sale was unarchived and archived again on its own.
    const j2 = await saleMade(server, ctx, 'C-2', 'INV-C2');
    const s2 = visitSale(j2.id);
    ok(await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j2.id }]));
    dbRun('UPDATE sales SET archived = 0 WHERE id = ?', [s2.id]);
    dbRun("INSERT INTO audit_log (entity_type, entity_id, changes_json) VALUES ('sale', ?, ?)", [s2.id, JSON.stringify({ archived: { from: 'Yes', to: 'No' } })]);
    dbRun('UPDATE sales SET archived = 1 WHERE id = ?', [s2.id]);
    dbRun("INSERT INTO audit_log (entity_type, entity_id, changes_json) VALUES ('sale', ?, ?)", [s2.id, JSON.stringify({ archived: { from: 'No', to: 'Yes' } })]);
    ok(await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j2.id }], false));
    assert.deepEqual([job(j2.id).archived, sale(s2.id).archived], [0, 1], 'not restored: its latest archive was its own');
  } finally {
    server.close();
  }
});

test('Quote Approved Later archive reverses only its own conversion; unarchive re-applies it only when the job is still eligible', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const kb = await noSale(server, ctx, 'D-1');
    const other = await noSale(server, ctx, 'D-2');
    const qOther = await qal(server, ctx, 'D-2', 'INV-D2');
    const q = await qal(server, ctx, 'D-1', 'INV-D1');
    assert.equal(job(kb.id).converted_by_sale_id, q.id);
    const r0 = await report(server);

    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: q.id }]));
    assert.deepEqual([job(kb.id).converted_later, job(kb.id).converted_by_sale_id], [0, null]);
    assert.equal(job(other.id).converted_by_sale_id, qOther.id, 'the other job and its conversion are untouched');
    const r1 = await report(server);
    assert.equal(r1.knockbacks, r0.knockbacks + 1);
    assert.equal(r1.totalSaleExGst, r0.totalSaleExGst - 900);

    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: q.id }], false));
    assert.equal(job(kb.id).converted_by_sale_id, q.id, 'still eligible: conversion re-applied');
    assert.deepEqual(await report(server), r0, 'figures exactly back to before');

    // Not eligible any more -> sale restored, conversion not re-applied.
    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: q.id }]));
    ok(await archiveEntries(server, [{ kind: 'new_job_no_sale', id: kb.id }]));
    const p = ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'quote_approved_later', id: q.id }], archived: false }));
    assert.match(p.notes.join(), /not marked "Converted later" again/);
    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: q.id }], false));
    assert.deepEqual([sale(q.id).archived, job(kb.id).converted_later], [0, 0]);
  } finally {
    server.close();
  }
});

test('a failed step rolls the whole action back: no record and no history entry changes', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'E-1', 'INV-E1');
    // Make the linked sale update fail half-way through the action.
    dbRun("CREATE TRIGGER fail_sale_archive BEFORE UPDATE OF archived ON sales BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const before = dump();
    const res = await archiveEntries(server, [{ kind: 'new_job_sale_made', id: j.id }]);
    assert.equal(res.status, 500);
    assert.deepEqual(dump(), before, 'the job was not left archived without its sale, and no history was written');
    dbRun('DROP TRIGGER fail_sale_archive');

    // Same for a Quote Approved Later Job Number edit that fails while relinking.
    await noSale(server, ctx, 'E-2');
    await noSale(server, ctx, 'E-3');
    const q = await qal(server, ctx, 'E-2', 'INV-E2');
    dbRun("CREATE TRIGGER fail_convert BEFORE UPDATE OF converted_later ON jobs WHEN NEW.converted_later = 1 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const before2 = dump();
    const edit = await server.request('PATCH', `/tech/quote-approved-later/${q.id}`, { jobNumber: 'E-3' });
    assert.equal(edit.status, 500);
    assert.deepEqual(dump(), before2, 'the sale and the old job are exactly as before');
  } finally {
    server.close();
  }
});

test('archive is admins only, kind-checked, and starting the app never archives or unarchives anything', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'F-1', 'INV-F1');
    const n = await noSale(server, ctx, 'F-2');
    dbRun('UPDATE jobs SET archived = 1 WHERE id = ?', [n.id]); // an existing archived record
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff@test.local', password: 'password123', role: 'staff' }));
    const states = () => dbAll('SELECT id, archived FROM jobs UNION ALL SELECT id + 100000, archived FROM sales ORDER BY 1');
    const before = states();

    // A fresh app start on the same database (i.e. a deployment) changes nothing.
    const again = createApp({ dbPath: server.dbPath });
    assert.ok(again);
    assert.deepEqual(states(), before);

    // Wrong kind for an id: never acted on.
    const s = visitSale(j.id);
    assert.equal((await server.request('POST', '/archive/preview', { items: [{ kind: 'quote_approved_later', id: s.id }], archived: true })).status, 404);
    assert.equal((await server.request('DELETE', `/tech/entries/quote_approved_later/${s.id}`)).status, 404);
    assert.ok(sale(s.id), 'the Sale Made sale was not deleted');

    await server.login('staff@test.local', 'password123');
    assert.equal((await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_sale_made', id: j.id }], archived: true })).status, 403);
    assert.equal((await server.request('POST', '/archive/apply', { items: [{ kind: 'new_job_sale_made', id: j.id }], archived: true, token: 'x' })).status, 403);
    assert.deepEqual(states(), before);
  } finally {
    server.close();
  }
});

test('a call and its pending cancellation archive together; one archived separately is never restored', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    await saleMade(server, ctx, 'G-1', 'INV-G1');
    const call = ok(await server.request('POST', '/calls', { callAt: '2026-05-03T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'G-1', cancellationReasonId: ctx.L.pending_cancellation_reason?.[0]?.id }));
    const pcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [call.id]).p;
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }]));
    assert.equal(dbGet('SELECT archived FROM pending_cancellations WHERE id = ?', [pcId]).archived, 1);
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }], false));
    assert.equal(dbGet('SELECT archived FROM pending_cancellations WHERE id = ?', [pcId]).archived, 0, 'restored with its call');

    ok(await archiveEntries(server, [{ kind: 'pending_cancellation', id: pcId }])); // archived on its own
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }]));
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }], false));
    assert.equal(dbGet('SELECT archived FROM pending_cancellations WHERE id = ?', [pcId]).archived, 1, 'archived separately: stays archived');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- editing

test('editing a Quote Approved Later Job Number moves the conversion from the old job to the new one, and is recorded', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const oldJob = await noSale(server, ctx, 'H-1');
    const newJob = await noSale(server, ctx, 'H-2');
    const notEligible = await noSale(server, ctx, 'H-3', 'Not Qualified');
    const q = await qal(server, ctx, 'H-1', 'INV-H1');
    const r0 = await report(server);

    const res = ok(await server.request('PATCH', `/tech/quote-approved-later/${q.id}`, { jobNumber: 'H-2' }));
    assert.match(res.notice, /H-1 is no longer marked "Converted later".*H-2 is now marked "Converted later"/);
    assert.deepEqual([job(oldJob.id).converted_later, job(oldJob.id).converted_by_sale_id], [0, null]);
    assert.deepEqual([job(newJob.id).converted_later, job(newJob.id).converted_by_sale_id], [1, q.id]);
    assert.equal(sale(q.id).job_id, newJob.id);
    assert.deepEqual(await report(server), r0, 'one knock-back still converted, so company figures are unchanged');
    assert.deepEqual(lastAudit('job', oldJob.id), { knockback: { from: 'Converted (quote approved later)', to: 'Yes' }, converted_by_sale: { from: q.id, to: null } });

    // Moving it to a job that isn't a knock-back: old conversion removed, nothing new applied.
    ok(await server.request('PATCH', `/tech/quote-approved-later/${q.id}`, { jobNumber: 'H-3' }));
    assert.equal(job(newJob.id).converted_later, 0);
    assert.equal(job(notEligible.id).converted_later, 0);
    assert.equal(sale(q.id).job_id, notEligible.id);
  } finally {
    server.close();
  }
});

test('editing a Sale Made job updates only its own sale, only for fields the edit changed', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'K-1', 'INV-K1', 600);
    const s = visitSale(j.id);
    // An unrelated sale that happens to share the job's id number.
    const unrelatedBefore = sale(j.id);

    ok(await server.request('PATCH', `/tech/new-job/${j.id}`, {
      technicianId: ctx.tB.id, jobNumber: 'K-1B', tradeId: ctx.electrical.id, jobTypeId: ctx.electrical.jobTypes[0].id, visitDate: '2026-05-05', lead: 'Qualified',
    }));
    const after = sale(s.id);
    assert.deepEqual(
      [after.credited_technician_id, after.job_number, after.trade_id, after.job_type_id, after.date_logged],
      [ctx.tB.id, 'K-1B', ctx.electrical.id, ctx.electrical.jobTypes[0].id, '2026-05-05']
    );
    if (unrelatedBefore && unrelatedBefore.id !== s.id) assert.deepEqual(sale(j.id), unrelatedBefore, 'a sale with the same id number is untouched');
    const tech = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data.byTechnician;
    assert.equal(tech.find((t) => t.name === 'Tech B').totalSaleExGst, 600, 'the sale is now credited to Tech B');
    assert.ok(lastAudit('sale', s.id).credited_technician_id, 'the sale change is in Activity history');

    // An older difference is not back-filled by an unrelated edit.
    dbRun('UPDATE sales SET date_logged = ? WHERE id = ?', ['2026-05-09', s.id]);
    ok(await server.request('PATCH', `/tech/new-job/${j.id}`, { comments: 'note only', lead: 'Qualified' }));
    assert.equal(sale(s.id).date_logged, '2026-05-09');
  } finally {
    server.close();
  }
});

test('editing a Pending Cancellation call keeps its own cancellation: no overwrite, no re-pointing, no new one', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await saleMade(server, ctx, 'P-1', 'INV-P1', 400);
    const original = visitSale(j.id);
    const call = ok(await server.request('POST', '/calls', { callAt: '2026-05-03T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'P-1', cancellationReasonId: ctx.L.pending_cancellation_reason?.[0]?.id }));
    const pcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [call.id]).p;
    // A correction on the Technician & Sales page, then an Upsell on the same job.
    ok(await server.request('PATCH', `/tech/pending-cancellations/${pcId}`, { creditedTechnicianId: ctx.tB.id }));
    ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'P-1', invoiceNumber: 'INV-P1', dateLogged: '2026-05-04', creditedTechnicianId: ctx.tB.id, invoiceDate: '2026-05-02', saleValueExGst: 50 }));

    ok(await server.request('PATCH', `/calls/${call.id}`, { notes: 'typo fix' }));
    const pc = dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]);
    assert.equal(pc.sale_id, original.id, 'still linked to the original sale, not the upsell');
    assert.equal(pc.credited_technician_id, ctx.tB.id, 'the correction is kept');
    assert.equal(pc.comments, 'typo fix', 'the field the edit changed is updated');
    assert.equal(dbAll('SELECT COUNT(*) n FROM pending_cancellations')[0].n, 1, 'no extra cancellation');

    // Deleted on the Technician & Sales page: an edit to the call doesn't bring it back.
    ok(await server.request('DELETE', `/tech/entries/pending_cancellation/${pcId}`));
    ok(await server.request('PATCH', `/calls/${call.id}`, { notes: 'another edit' }));
    assert.equal(dbAll('SELECT COUNT(*) n FROM pending_cancellations')[0].n, 0);

    // A call newly edited into a Pending Cancellation gets exactly one, linked to the original sale.
    const other = ok(await server.request('POST', '/calls', { callAt: '2026-05-05T10:00', direction: 'Inbound', callType: 'Not lead' }));
    ok(await server.request('PATCH', `/calls/${other.id}`, { callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'P-1' }));
    const created = dbAll('SELECT * FROM pending_cancellations');
    assert.equal(created.length, 1);
    assert.equal(created[0].sale_id, original.id);
  } finally {
    server.close();
  }
});

test('a Job Number already used by another active job is refused on edit and on unarchive, leaving everything unchanged', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const a = await noSale(server, ctx, 'J-1');
    const b = await noSale(server, ctx, 'J-2');
    const before = dump();
    const res = await server.request('PATCH', `/tech/new-job/${b.id}`, { jobNumber: ' j-1 ', comments: 'sent with it', lead: 'Qualified' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /already used by another active job.*Nothing was changed/);
    assert.deepEqual(dump(), before);

    // Archived jobs don't block; unarchiving onto a number now in use is refused.
    ok(await archiveEntries(server, [{ kind: 'new_job_no_sale', id: a.id }]));
    ok(await server.request('PATCH', `/tech/new-job/${b.id}`, { jobNumber: 'J-1', lead: 'Qualified' }));
    const unarchive = await server.request('POST', '/archive/preview', { items: [{ kind: 'new_job_no_sale', id: a.id }], archived: false });
    assert.equal(unarchive.status, 400);
    assert.match(unarchive.data.error, /another active job already uses Job Number J-1/);
    assert.equal(job(a.id).archived, 1);
  } finally {
    server.close();
  }
});
