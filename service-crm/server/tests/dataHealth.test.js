import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, run as dbRun } from '../src/db/index.js';

// Settings -> Data health (GET /api/data-health): read-only checks listing
// existing records affected by each known data issue. Each issue below is
// created the way it really arises (the old bug paths where they still
// exist, otherwise written directly as such rows already sit in a database).

const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'follow_up_events', 'audit_log', 'users'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const byId = (data) => Object.fromEntries(data.checks.map((c) => [c.id, c]));

async function setup(server) {
  await server.login();
  const b = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tA = (await server.request('POST', '/settings/technicians', { name: 'Tech A' })).data;
  const tB = (await server.request('POST', '/settings/technicians', { name: 'Tech B' })).data;
  return { plumbing, jobTypeId: plumbing.jobTypes[0].id, L: b.lists, tA, tB };
}

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

function noSale(server, ctx, jobNumber, lead = 'Qualified', tech = ctx.tA) {
  return server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale', visitDate: '2026-05-01', technicianId: tech.id, jobNumber, tradeId: ctx.plumbing.id, jobTypeId: ctx.jobTypeId,
    lead, knockbackReasonId: lead === 'Qualified' ? ctx.L.knockback_reason[0].id : null, ...(lead === 'Not Qualified' ? { inspectionSheet: 'N/A', optionSheet: 'N/A' } : {}),
  });
}
function saleMade(server, ctx, jobNumber, invoiceNumber, value = 500, tech = ctx.tA) {
  return server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-02', technicianId: tech.id, jobNumber, tradeId: ctx.plumbing.id, jobTypeId: ctx.jobTypeId,
    lead: 'Qualified', invoiceNumber, invoiceDate: '2026-05-02', saleValueExGst: value,
  });
}
function qal(server, ctx, jobNumber, invoiceNumber, value = 900) {
  return server.request('POST', '/tech/quote-approved-later', {
    jobNumber, newJobNumber: `AF-${jobNumber}`, dateLogged: '2026-05-10', creditedTechnicianId: ctx.tA.id, invoiceNumber, invoiceDate: '2026-05-10', saleValueExGst: value,
  });
}

test('a clean database reports nothing on every check', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    ok(await noSale(server, ctx, 'OK-1'));
    ok(await saleMade(server, ctx, 'OK-2', 'INV-OK-2'));
    ok(await qal(server, ctx, 'OK-1', 'INV-OK-1'));
    ok(await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: ctx.L.lead_source[0].id, jobNumber: 'OK-1' }));
    const res = await server.request('GET', '/data-health');
    assert.equal(res.status, 200);
    assert.equal(res.data.checks.length, 12);
    for (const c of res.data.checks) assert.equal(c.count, 0, `${c.id} should be clean`);
  } finally {
    server.close();
  }
});

test('every known issue is found, with the figures a fix would move', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);

    // 5: archive a Sale Made job (its sale stays active).
    const s5 = ok(await saleMade(server, ctx, 'H-5', 'INV-H5', 1000)).entry;
    ok(await server.request('PATCH', `/tech/entries/new_job_sale_made/${s5.id}/archive`, { archived: true }));

    // 6: knock-back converted by a Quote Approved Later, then that sale archived.
    ok(await noSale(server, ctx, 'H-6'));
    const q6 = ok(await qal(server, ctx, 'H-6', 'INV-H6')).entry;
    dbRun('UPDATE sales SET archived = 1 WHERE id = ?', [q6.id]);

    // 7: Quote Approved Later sale's Job Number edited after saving.
    ok(await noSale(server, ctx, 'H-7'));
    ok(await noSale(server, ctx, 'H-7B'));
    const q7 = ok(await qal(server, ctx, 'H-7', 'INV-H7')).entry;
    ok(await server.request('PATCH', `/tech/quote-approved-later/${q7.id}`, { jobNumber: 'H-7B' }));

    // 8: an older, inconsistent knock-back flag.
    const j8 = ok(await noSale(server, ctx, 'H-8')).entry;
    dbRun('UPDATE jobs SET knockback = 0 WHERE id = ?', [j8.id]);

    // 9: Sale Made job's technician edited; its sale keeps the old one.
    const s9 = ok(await saleMade(server, ctx, 'H-9', 'INV-H9', 700)).entry;
    ok(await server.request('PATCH', `/tech/new-job/${s9.id}`, { technicianId: ctx.tB.id }));

    // 14: pending cancellation re-pointed at an upsell by a later call edit.
    ok(await saleMade(server, ctx, 'H-14', 'INV-H14', 400));
    const pcCall = ok(await server.request('POST', '/calls', { callAt: '2026-05-03T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'H-14', cancellationReasonId: ctx.L.pending_cancellation_reason?.[0]?.id }));
    ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'H-14', invoiceNumber: 'INV-H14', dateLogged: '2026-05-04', creditedTechnicianId: ctx.tB.id, invoiceDate: '2026-05-02', saleValueExGst: 50 }));
    ok(await server.request('PATCH', `/calls/${pcCall.id}`, { notes: 'typo fix' }));

    // 15: a job's Job Number edited onto another active job's.
    const j15 = ok(await noSale(server, ctx, 'H-15A')).entry;
    ok(await noSale(server, ctx, 'H-15'));
    ok(await server.request('PATCH', `/tech/new-job/${j15.id}`, { jobNumber: 'H-15' }));

    // Lead rules: older Sale Made + Not Qualified, older Not Qualified with "No".
    const sNQ = ok(await saleMade(server, ctx, 'H-NQ', 'INV-HNQ', 300)).entry;
    dbRun("UPDATE jobs SET lead = 'Not Qualified' WHERE id = ?", [sNQ.id]);
    const jNQ = ok(await noSale(server, ctx, 'H-NQS', 'Not Qualified')).entry;
    dbRun("UPDATE jobs SET inspection_sheet = 'No' WHERE id = ?", [jNQ.id]);

    // 10/11: the same invoice on two sales.
    ok(await saleMade(server, ctx, 'H-10A', 'INV-DUP', 200));
    ok(await saleMade(server, ctx, 'H-10B', 'INV-DUP', 200, ctx.tB));

    // 12: booked Lead with no Job Number. 13: two booked Leads, different sources.
    ok(await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: ctx.L.lead_source[0].id, jobNumber: '' }));
    ok(await server.request('POST', '/calls', { callAt: '2026-04-20T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: ctx.L.lead_source[0].id, jobNumber: 'H-13' }));
    ok(await server.request('POST', '/calls', { callAt: '2026-05-02T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: ctx.L.lead_source[1].id, jobNumber: 'h-13 ' }));

    const before = dump();
    const res = await server.request('GET', '/data-health');
    assert.equal(res.status, 200);
    assert.deepEqual(dump(), before, 'running the checks changes nothing');
    const c = byId(res.data);

    assert.deepEqual(c.archivedJobActiveSale.rows.map((r) => [r.jobNumber, r.saleValue]), [['H-5', 1000]]);
    assert.match(c.archivedJobActiveSale.effect, /1 sale\(s\) worth \$1000/);
    assert.deepEqual(c.convertedWithoutActiveSale.rows.map((r) => [r.jobNumber, r.saleStatus]), [['H-6', 'archived']]);
    assert.deepEqual(c.qalLinkMismatch.rows.map((r) => [r.saleJobNumber, r.linkedJobNumber]), [['H-7B', 'H-7']]);
    assert.deepEqual(c.knockbackFlagMismatch.rows.map((r) => [r.jobNumber, r.storedKnockback, r.expectedKnockback]), [['H-8', 'No', 'Yes']]);
    assert.deepEqual(c.visitSaleMismatch.rows.map((r) => [r.jobNumber, r.jobTechnician, r.saleCreditedTechnician]), [['H-9', 'Tech B', 'Tech A']]);
    assert.match(c.visitSaleMismatch.effect, /\$700 ex GST/);
    assert.deepEqual(c.pendingCancellationOnUpsell.rows.map((r) => [r.jobNumber, r.upsellValue]), [['H-14', 50]]);
    assert.deepEqual(c.duplicateJobNumbers.rows.map((r) => [r.jobNumber, r.activeJobs]), [['h-15', 2]]);
    assert.deepEqual(c.saleMadeNotQualified.rows.map((r) => r.jobNumber), ['H-NQ']);
    assert.deepEqual(c.notQualifiedWithSheets.rows.map((r) => [r.jobNumber, r.inspectionSheet]), [['H-NQS', 'No']]);
    assert.deepEqual(c.duplicateInvoices.rows.map((r) => [r.invoiceNumber, r.sales]), [['inv-dup', 2]]);
    assert.equal(c.bookedLeadNoJobNumber.count, 1);
    assert.deepEqual(c.conflictingLeadSources.rows.map((r) => [r.jobNumber, r.bookedLeadCalls]), [['h-13', 2]]);
  } finally {
    server.close();
  }
});

test('archived records are left out of every check', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    ok(await saleMade(server, ctx, 'AR-1', 'INV-AR', 100));
    ok(await saleMade(server, ctx, 'AR-2', 'INV-AR', 100));
    dbRun("UPDATE sales SET archived = 1 WHERE job_number = 'AR-2'");
    dbRun("UPDATE jobs SET archived = 1 WHERE job_number = 'AR-2'");
    const c = byId((await server.request('GET', '/data-health')).data);
    assert.equal(c.duplicateInvoices.count, 0, 'an archived duplicate is not counted');
    assert.equal(c.archivedJobActiveSale.count, 0, 'job and sale both archived is consistent');
  } finally {
    server.close();
  }
});

test('staff cannot run the checks', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    ok(await server.request('POST', '/users', { name: 'Staff Sam', email: 'sam@test.local', password: 'password123', role: 'staff' }));
    await server.login('sam@test.local', 'password123');
    assert.equal((await server.request('GET', '/data-health')).status, 403);
  } finally {
    server.close();
  }
});
