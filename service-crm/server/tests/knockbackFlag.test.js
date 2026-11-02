import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';

// Stored knock-back flag: the admin "Correct knock-back flag" action on Data
// Health check 8 (lib/archive.js), and keeping the flag consistent when Lead
// Qualification is changed on an edit (lib/leadRules.js).

const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'follow_up_events', 'audit_log'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const row = (id) => dbGet('SELECT * FROM jobs WHERE id = ?', [id]);
const lastAudit = (id) => JSON.parse(dbGet("SELECT changes_json FROM audit_log WHERE entity_type = 'job' AND entity_id = ? ORDER BY id DESC LIMIT 1", [id]).changes_json);
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function setup(server) {
  await server.login();
  const b = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'KB Tech' }));
  return { plumbing, jobTypeId: plumbing.jobTypes[0].id, reasonId: b.lists.knockback_reason[0].id, tech };
}
const newJob = async (server, ctx, jobNumber, lead, kind = 'new_job_no_sale') =>
  ok(
    await server.request('POST', '/tech/new-job', {
      kind,
      visitDate: '2026-05-01',
      technicianId: ctx.tech.id,
      jobNumber,
      tradeId: ctx.plumbing.id,
      jobTypeId: ctx.jobTypeId,
      lead,
      ...(lead === 'Not Qualified' ? { inspectionSheet: 'N/A', optionSheet: 'N/A' } : {}),
      knockbackReasonId: kind === 'new_job_no_sale' && lead === 'Qualified' ? ctx.reasonId : null,
      ...(kind === 'new_job_sale_made' ? { invoiceNumber: `INV-${jobNumber}`, invoiceDate: '2026-05-01', saleValueExGst: 500 } : {}),
    })
  ).entry;
const check8 = async (server) => ok(await server.request('GET', '/data-health')).checks.find((c) => c.id === 'knockbackFlagMismatch');
const report = async (server) => ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).company;
const preview = (server, jobId) => server.request('POST', '/archive/knockback-flag/preview', { jobId });
const apply = (server, jobId, token) => server.request('POST', '/archive/knockback-flag/apply', { jobId, token });

// The JN 2287 situation: Not Qualified, No Sale, stored knock-back flag Yes.
async function like2287(server, ctx, jn = '2287') {
  const j = await newJob(server, ctx, jn, 'Not Qualified');
  dbRun('UPDATE jobs SET knockback = 1 WHERE id = ?', [j.id]);
  return j;
}

test('JN 2287: preview shows exactly what changes; cancelling changes nothing; confirming changes only the stored flag, recorded, and Data Health clears', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await like2287(server, ctx);
    const other = await newJob(server, ctx, 'OK-1', 'Qualified');
    const c0 = await check8(server);
    assert.equal(c0.count, 1);
    assert.equal(c0.rows[0].jobId, j.id);
    assert.equal(c0.rows[0].conflict, '', 'no conflict, so the action is offered');
    assert.equal(c0.action, 'correctKnockbackFlag');
    const r0 = await report(server);
    const before = dump();

    // Preview = what the confirmation shows. Cancelling = never calling apply.
    const p = ok(await preview(server, j.id));
    const details = p.details.join('\n');
    assert.match(details, /Current qualification: Not Qualified/);
    assert.match(details, /Current stored knock-back flag: Yes/);
    assert.match(details, /Correct stored knock-back flag: No/);
    assert.match(details, /Report figures affected: none/);
    assert.match(details, /Follow-ups affected: none/);
    assert.match(details, /Converted Later links affected: none/);
    assert.deepEqual(p.changes, [`Change JN 2287 (visit 2026-05-01)'s stored knock-back flag from Yes to No`]);
    assert.equal(p.linkedChanges.length, 0);
    assert.deepEqual(dump(), before, 'previewing (then cancelling) changes nothing');

    // Wrong / missing token: nothing changes.
    assert.equal((await apply(server, j.id)).status, 409);
    assert.equal((await apply(server, j.id, 'stale')).status, 409);
    assert.deepEqual(dump(), before);

    ok(await apply(server, j.id, p.token));
    const after = dump();
    const jb = before.jobs.find((r) => r.id === j.id);
    const ja = after.jobs.find((r) => r.id === j.id);
    assert.deepEqual({ ...ja, updated_at: null }, { ...jb, knockback: 0, updated_at: null }, 'only the stored flag changed on JN 2287');
    for (const t of TABLES.filter((x) => x !== 'jobs' && x !== 'audit_log')) assert.deepEqual(after[t], before[t], `${t} unchanged`);
    assert.deepEqual(after.jobs.filter((r) => r.id !== j.id), before.jobs.filter((r) => r.id !== j.id), 'no other job changed');
    assert.equal(after.audit_log.length, before.audit_log.length + 1, 'one Activity history entry');
    assert.deepEqual(lastAudit(j.id), { stored_knockback_flag: { from: 'Yes', to: 'No' } });
    const history = ok(await server.request('GET', `/tech/entries/new_job_no_sale/${j.id}/history`));
    assert.deepEqual(history[0].changes, { stored_knockback_flag: { from: 'Yes', to: 'No' } });

    assert.deepEqual(await report(server), r0, 'report figures unchanged');
    assert.equal((await check8(server)).count, 0, 'Data Health check 8 clears');
    assert.equal(row(other.id).knockback, 1);

    // Repeated request: unavailable once corrected, nothing changes.
    const again = await preview(server, j.id);
    assert.equal(again.status, 400);
    assert.match(again.data.error, /already correct/);
    const snapshot = dump();
    assert.equal((await apply(server, j.id, p.token)).status, 400);
    assert.deepEqual(dump(), snapshot);
  } finally {
    server.close();
  }
});

test('a flagged job with an open follow-up, a Converted Later link or a Quote Approved Later sale is refused and shown for separate review', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    // Open follow-up on a mismatched job.
    const a = await newJob(server, ctx, 'C-1', 'Qualified');
    ok(await server.request('POST', '/follow-ups', { jobId: a.id, dueDate: '2026-06-01' }));
    dbRun("UPDATE jobs SET lead = 'Not Qualified' WHERE id = ?", [a.id]);
    // Converted Later link on a mismatched job.
    const b = await newJob(server, ctx, 'C-2', 'Qualified');
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'C-2', newJobNumber: 'AF-C2', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-C2', invoiceDate: '2026-05-10', saleValueExGst: 700 }));
    assert.equal(row(b.id).converted_later, 1);
    dbRun("UPDATE jobs SET lead = 'Not Qualified' WHERE id = ?", [b.id]);
    // Quote Approved Later sale saved against a job with flag No (the JN 2325 situation).
    const c = await newJob(server, ctx, 'C-3', 'Qualified');
    dbRun('UPDATE jobs SET knockback = 0 WHERE id = ?', [c.id]);
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'C-3', newJobNumber: 'AF-C3', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-C3', invoiceDate: '2026-05-10', saleValueExGst: 700 }));

    const rows = (await check8(server)).rows;
    assert.equal(rows.length, 3);
    const conflict = (id) => rows.find((r) => r.jobId === id).conflict;
    assert.match(conflict(a.id), /open follow-up/);
    assert.match(conflict(b.id), /Converted Later link/);
    assert.match(conflict(c.id), /Quote Approved Later sale/);

    const before = dump();
    for (const [id, re] of [[a.id, /open follow-up/], [b.id, /Converted Later link/], [c.id, /Quote Approved Later sale/]]) {
      const res = await preview(server, id);
      assert.equal(res.status, 409);
      assert.match(res.data.error, re);
      assert.match(res.data.error, /review that separately — nothing was changed/);
      assert.equal((await apply(server, id, 'anything')).status, 409);
    }
    assert.deepEqual(dump(), before, 'nothing changed, nothing unlinked, no follow-up touched');

    // Not offered for jobs that aren't mismatched, archived, or missing.
    const fine = await newJob(server, ctx, 'C-4', 'Qualified');
    assert.match((await preview(server, fine.id)).data.error, /already correct/);
    const arch = await like2287(server, ctx, 'C-5');
    dbRun('UPDATE jobs SET archived = 1 WHERE id = ?', [arch.id]);
    assert.match((await preview(server, arch.id)).data.error, /archived/);
    assert.equal((await preview(server, 99999)).status, 404);
    assert.deepEqual(dump().jobs.map((r) => r.knockback), before.jobs.map((r) => r.knockback).concat([1, 1]));
  } finally {
    server.close();
  }
});

test('a failed correction rolls back completely', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await like2287(server, ctx);
    const p = ok(await preview(server, j.id));
    dbRun("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const before = dump();
    assert.equal((await apply(server, j.id, p.token)).status, 500);
    dbRun('DROP TRIGGER fail_audit');
    assert.deepEqual(dump(), before, 'flag not changed without its history entry');
    assert.equal(row(j.id).knockback, 1);
  } finally {
    server.close();
  }
});

test('staff cannot use the correction', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await like2287(server, ctx);
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-kb@test.local', password: 'password123', role: 'staff' }));
    await server.login('staff-kb@test.local', 'password123');
    assert.equal((await preview(server, j.id)).status, 403);
    assert.equal((await apply(server, j.id, 'x')).status, 403);
    assert.equal(row(j.id).knockback, 1);
  } finally {
    server.close();
  }
});

// ------------------------------------------------- Lead changes on an edit

test('Qualified No Sale -> Not Qualified stores knock-back No; Not Qualified -> Qualified stores Yes and needs a reason; both recorded', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await newJob(server, ctx, 'E-1', 'Qualified');
    assert.equal(row(j.id).knockback, 1);
    ok(await server.request('PATCH', `/tech/new-job/${j.id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null }));
    assert.deepEqual([row(j.id).lead, row(j.id).knockback, row(j.id).knockback_reason_id], ['Not Qualified', 0, null]);
    assert.deepEqual(lastAudit(j.id).knockback, { from: 1, to: 0 });

    const before = dump();
    const noReason = await server.request('PATCH', `/tech/new-job/${j.id}`, { lead: 'Qualified' });
    assert.equal(noReason.status, 400);
    assert.match(noReason.data.error, /Reason for Knockback/);
    assert.deepEqual(dump(), before, 'refused edit changes nothing');

    ok(await server.request('PATCH', `/tech/new-job/${j.id}`, { lead: 'Qualified', knockbackReasonId: ctx.reasonId }));
    assert.deepEqual([row(j.id).lead, row(j.id).knockback], ['Qualified', 1]);
    assert.deepEqual(lastAudit(j.id).knockback, { from: 0, to: 1 });
    assert.equal((await check8(server)).count, 0);
  } finally {
    server.close();
  }
});

test('No Sale can’t become Sale Made by an edit, and Sale Made can’t become Not Qualified or a knock-back', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const ns = await newJob(server, ctx, 'S-1', 'Qualified');
    const before = dump();
    await server.request('PATCH', `/tech/new-job/${ns.id}`, { kind: 'new_job_sale_made', invoiceNumber: 'INV-X', invoiceDate: '2026-05-02', saleValueExGst: 900 });
    assert.equal(row(ns.id).had_sale_at_visit, 0, 'entry type is fixed once saved');
    assert.equal(row(ns.id).knockback, 1);
    assert.deepEqual(dump().sales, before.sales, 'no sale created');

    const sm = await newJob(server, ctx, 'S-2', 'Qualified', 'new_job_sale_made');
    assert.equal(row(sm.id).knockback, 0);
    const snap = dump();
    const res = await server.request('PATCH', `/tech/new-job/${sm.id}`, { lead: 'Not Qualified' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /always Qualified/);
    assert.deepEqual(dump(), snap);
    ok(await server.request('PATCH', `/tech/new-job/${sm.id}`, { comments: 'note', knockbackReasonId: ctx.reasonId }));
    assert.deepEqual([row(sm.id).lead, row(sm.id).knockback, row(sm.id).knockback_reason_id], ['Qualified', 0, null]);
  } finally {
    server.close();
  }
});

test('a Lead change is blocked, changing nothing, by an open follow-up, a Converted Later link, or a Quote Approved Later sale saved against the job', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const toNQ = { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null, comments: 'sent alongside' };

    const a = await newJob(server, ctx, 'B-1', 'Qualified');
    ok(await server.request('POST', '/follow-ups', { jobId: a.id, dueDate: '2026-06-01' }));
    const b = await newJob(server, ctx, 'B-2', 'Qualified');
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'B-2', newJobNumber: 'AF-B2', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-B2', invoiceDate: '2026-05-10', saleValueExGst: 700 }));
    const c = await newJob(server, ctx, 'B-3', 'Qualified');
    dbRun('UPDATE jobs SET knockback = 0 WHERE id = ?', [c.id]);
    ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'B-3', newJobNumber: 'AF-B3', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-B3', invoiceDate: '2026-05-10', saleValueExGst: 700 }));
    assert.equal(row(c.id).converted_later, 0, 'saved unlinked');

    const before = dump();
    for (const [id, re] of [[a.id, /open follow-up/], [b.id, /Converted Later/], [c.id, /Quote Approved Later sale saved against it/]]) {
      const res = await server.request('PATCH', `/tech/new-job/${id}`, toNQ);
      assert.equal(res.status, 409);
      assert.match(res.data.error, re);
      assert.match(res.data.error, /Nothing was changed/);
    }
    assert.deepEqual(dump(), before, 'every field, follow-up and link unchanged');
    // The edit form gets the same reasons, so it can lock Lead before saving.
    const entries = ok(await server.request('GET', '/tech/entries'));
    const blocked = (id) => entries.find((e) => e.kind === 'new_job_no_sale' && e.id === id).leadChangeBlockedBy;
    assert.deepEqual(blocked(a.id), ['an open follow-up']);
    assert.deepEqual(blocked(b.id), ['a Converted Later link']);
    assert.deepEqual(blocked(c.id), ['a Quote Approved Later sale saved against it']);
    const free = await newJob(server, ctx, 'B-4', 'Qualified');
    assert.deepEqual(ok(await server.request('GET', '/tech/entries')).find((e) => e.id === free.id && e.kind === 'new_job_no_sale').leadChangeBlockedBy, []);
    // Edits that don't change Lead still work and don't touch the flag.
    ok(await server.request('PATCH', `/tech/new-job/${c.id}`, { comments: 'note only' }));
    assert.equal(row(c.id).knockback, 0, 'no automatic correction on an unrelated save');
  } finally {
    server.close();
  }
});

test('a failed Lead edit rolls back completely', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const j = await newJob(server, ctx, 'R-1', 'Qualified');
    dbRun("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const before = dump();
    const res = await server.request('PATCH', `/tech/new-job/${j.id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null });
    dbRun('DROP TRIGGER fail_audit');
    assert.equal(res.status, 500);
    assert.deepEqual(dump(), before);
    assert.deepEqual([row(j.id).lead, row(j.id).knockback], ['Qualified', 1]);
  } finally {
    server.close();
  }
});
