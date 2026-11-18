import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all, run } from '../src/db/index.js';
import { adelaideDateStamp, addDays } from '../src/lib/adelaideTime.js';

// Stage 4 — Needs Attention: the approved rules and timings, office-only
// access, Mine/All, "Reviewed — leave as is" (reason required, stays
// dismissed), Closed and reopening (recorded), read-only, backups.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const today = adelaideDateStamp();
const daysAgo = (n) => addDays(today, -n);
const STAFF = { name: 'Sam Staff', email: 'sam@justtrades.au', password: 'password123', role: 'staff' };
const TABLES = ['calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'follow_ups', 'audit_log'];
const dump = () => Object.fromEntries(TABLES.map((t) => [t, all(`SELECT * FROM ${t} ORDER BY rowid`)]));

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Kurt Tech' }));
  const job = (jobNumber, visitDate, extra = {}) =>
    server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate, technicianId: tech.id, jobNumber, tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Not Qualified', suburb: 'Kilburn (5084)', ...extra,
    });
  const leadCall = (jobNumber, date, extra = {}) =>
    server.request('POST', '/calls', { callAt: `${date}T09:00`, direction: 'Inbound', callType: 'Lead', booked: 'Yes', jobNumber, ...extra });
  return { b, plumbing, tech, job, leadCall };
}
const itemsOf = (data, rule) => data.groups.find((g) => g.id === rule).items;

test('only office accounts (Admin and Staff) can use Needs Attention; Technician accounts are refused', async () => {
  const server = await startTestServer();
  try {
    const { tech } = await setup(server);
    ok(await server.request('POST', '/users', STAFF));
    const t = ok(await server.request('POST', '/users', { ...STAFF, name: 'Kurt', email: 'kurt@justtrades.au' }));
    ok(await server.request('POST', `/users/${t.id}/technician-link`, { technicianId: tech.id, confirm: true }));
    assert.equal((await server.request('GET', '/needs-attention')).status, 200, 'Admin');
    await server.login(STAFF.email, STAFF.password);
    assert.equal((await server.request('GET', '/needs-attention')).status, 200, 'Staff');
    await server.login('kurt@justtrades.au', STAFF.password);
    for (const [m, p] of [['GET', '/needs-attention'], ['GET', '/needs-attention/closed'], ['GET', '/needs-attention/count'], ['GET', '/needs-attention/history'], ['POST', '/needs-attention/dismiss'], ['POST', '/needs-attention/reopen']]) {
      assert.equal((await server.request(m, p, m === 'GET' ? undefined : {})).status, 403, `Technician: ${m} ${p}`);
    }
  } finally {
    server.close();
  }
});

test('each rule shows the right records at the right time, and an item disappears when fixed', async () => {
  const server = await startTestServer();
  try {
    const { b, tech, job, leadCall } = await setup(server);
    // 1. Booked Lead with no Job Number — straight away.
    const noJn = ok(await leadCall('', today));
    // 2. Job with no Job Number — straight away (created directly: the form requires it).
    const blank = ok(await job('TMP-BLANK', daysAgo(1)));
    run("UPDATE jobs SET job_number = '' WHERE id = ?", [blank.entry.id]);
    // 3. Job from 1 Oct with no booked Lead / Call back call; a September one is ignored.
    ok(await job('UN-1', '2026-10-05'));
    ok(await job('UN-SEP', '2026-09-20'));
    // 4. Booked Lead with a Job Number, nothing logged: flagged at 14 days, not at 13.
    ok(await leadCall('BL-14', daysAgo(14)));
    ok(await leadCall('BL-13', daysAgo(13)));
    ok(await leadCall('BL-DONE', daysAgo(30)));
    ok(await job('BL-DONE', daysAgo(29)));
    // 7. Call Back entry with no new Job Number: 7 days yes, 6 days no.
    ok(await job('ORIG-1', daysAgo(40)));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'ORIG-1', visitDate: daysAgo(7), technicianId: tech.id, creditedTechnicianId: tech.id }));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'ORIG-1', visitDate: daysAgo(6), technicianId: tech.id, creditedTechnicianId: tech.id }));
    // 8. Job with no suburb from 1 Oct; September ignored.
    ok(await job('SUB-1', '2026-10-10', { suburb: '' }));
    ok(await job('SUB-SEP', '2026-09-10', { suburb: '' }));
    // Overdue follow-up (count only).
    run("INSERT INTO follow_ups (job_id, job_number, due_date, status, original_attendance_date, created_by_user_id) SELECT id, job_number, ?, 'active', visit_date, 1 FROM jobs WHERE job_number = 'ORIG-1'", [daysAgo(3)]);

    const d = ok(await server.request('GET', '/needs-attention'));
    assert.deepEqual(itemsOf(d, 'booked-lead-no-job-number').map((i) => i.open), [{ module: 'calls', id: noJn.id }]);
    assert.ok(itemsOf(d, 'no-job-number').some((i) => i.key === `job:${blank.entry.id}:no-job-number`));
    assert.deepEqual(itemsOf(d, 'unassigned-job').map((i) => i.jobNumber).filter((j) => j.startsWith('UN-')), ['UN-1']);
    assert.deepEqual(itemsOf(d, 'booked-lead-no-entry').map((i) => i.jobNumber), ['BL-14']);
    assert.equal(itemsOf(d, 'callback-new-job-number').length, 1, 'only the 7-day-old Call Back entry');
    assert.deepEqual(itemsOf(d, 'job-no-suburb').map((i) => i.jobNumber), ['SUB-1']);
    assert.equal(d.overdueFollowUps, 1);

    // Fixing the record removes the item.
    ok(await server.request('PATCH', `/calls/${noJn.id}`, { jobNumber: 'NOW-SET' }));
    const after = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(after, 'booked-lead-no-job-number').length, 0);
    assert.ok(b);
  } finally {
    server.close();
  }
});

test('Sale Made mismatch and Pending Cancellation rules match their existing checks', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const sold = ok(await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: daysAgo(3), technicianId: tech.id, jobNumber: 'SM-1', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified', invoiceNumber: 'INV-SM-1', invoiceDate: daysAgo(3), saleValueExGst: 900,
    }));
    run("UPDATE sales SET date_logged = ? WHERE job_number = 'SM-1'", [daysAgo(2)]);
    const health = ok(await server.request('GET', '/data-health'));
    const healthCount = (health.checks || []).find((c) => c.id === 'visitSaleMismatch').count;
    const d = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(d, 'sale-made-mismatch').length, healthCount, 'same as Data Health');
    assert.equal(itemsOf(d, 'sale-made-mismatch')[0].open.id, sold.entry.id);

    // Pending Cancellation without invoice details: shown after 2 days, opens its call.
    const call = ok(await server.request('POST', '/calls', {
      callAt: `${daysAgo(2)}T10:00`, direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'SM-1',
      pendingCancellationCreditedTechnicianId: tech.id,
    }));
    const pc = all('SELECT id, date_logged FROM pending_cancellations')[0];
    assert.ok(pc, 'the Pending Cancellation call created a Pending Cancellation');
    run('UPDATE pending_cancellations SET date_logged = ? WHERE id = ?', [daysAgo(1), pc.id]);
    assert.equal(itemsOf(ok(await server.request('GET', '/needs-attention')), 'pending-cancellation-details').length, 0, 'not before 2 days');
    run('UPDATE pending_cancellations SET date_logged = ? WHERE id = ?', [daysAgo(2), pc.id]);
    const items = itemsOf(ok(await server.request('GET', '/needs-attention')), 'pending-cancellation-details');
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].open, { module: 'calls', id: call.id });
  } finally {
    server.close();
  }
});

test('Mine shows only the signed-in user\'s items; All shows everyone\'s', async () => {
  const server = await startTestServer();
  try {
    const { leadCall } = await setup(server);
    ok(await server.request('POST', '/users', STAFF));
    ok(await leadCall('', today));
    await server.login(STAFF.email, STAFF.password);
    ok(await leadCall('', today));
    const mine = ok(await server.request('GET', '/needs-attention?mine=1'));
    const everyone = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(mine, 'booked-lead-no-job-number').length, 1);
    assert.equal(itemsOf(everyone, 'booked-lead-no-job-number').length, 2);
  } finally {
    server.close();
  }
});

test('Reviewed — leave as is: reason required, recorded, moves to Closed and stays there even if the record changes; reopening is recorded', async () => {
  const server = await startTestServer();
  try {
    const { leadCall } = await setup(server);
    ok(await server.request('POST', '/users', STAFF));
    const call = ok(await leadCall('', today));
    const key = `call:${call.id}:booked-lead-no-job-number`;
    const before = dump();

    // Reading never changes a record.
    ok(await server.request('GET', '/needs-attention'));
    ok(await server.request('GET', '/needs-attention/closed'));
    assert.deepEqual(dump(), before, 'reading is read-only');

    await server.login(STAFF.email, STAFF.password);
    assert.equal((await server.request('POST', '/needs-attention/dismiss', { key, reason: '   ' })).status, 400, 'reason required');
    assert.equal((await server.request('POST', '/needs-attention/dismiss', { key: 'call:999:nope', reason: 'x' })).status, 404, 'only current items');
    ok(await server.request('POST', '/needs-attention/dismiss', { key, reason: 'Customer booked by text; JN to follow' }));
    assert.equal((await server.request('POST', '/needs-attention/dismiss', { key, reason: 'again' })).status, 409);
    assert.deepEqual(dump(), before, 'dismissing never changes a record');

    let active = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(active, 'booked-lead-no-job-number').length, 0, 'gone from the active list');
    let closed = ok(await server.request('GET', '/needs-attention/closed')).items;
    assert.equal(closed.length, 1);
    assert.equal(closed[0].reason, 'Customer booked by text; JN to follow');
    assert.equal(closed[0].dismissedBy, 'Sam Staff');
    assert.equal(closed[0].stillApplies, true);

    // The record changes (still no Job Number): it stays dismissed.
    await server.login();
    ok(await server.request('PATCH', `/calls/${call.id}`, { notes: 'Customer rang again' }));
    active = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(active, 'booked-lead-no-job-number').length, 0, 'stays dismissed after the record changes');

    // Admin reopens it: back on the active list, recorded.
    ok(await server.request('POST', '/needs-attention/reopen', { key }));
    active = ok(await server.request('GET', '/needs-attention'));
    assert.equal(itemsOf(active, 'booked-lead-no-job-number').length, 1);
    const row = all('SELECT * FROM needs_attention_reviews')[0];
    assert.equal(row.dismissed_by_name, 'Sam Staff');
    assert.equal(row.reopened_by_name, 'Admin');
    assert.ok(row.reopened_at);
    const history = ok(await server.request('GET', '/needs-attention/history')).events;
    assert.deepEqual(history.map((e) => e.action).sort(), ['dismissed', 'reopened']);

    // Staff can reopen too.
    await server.login(STAFF.email, STAFF.password);
    ok(await server.request('POST', '/needs-attention/dismiss', { key, reason: 'Second look' }));
    ok(await server.request('POST', '/needs-attention/reopen', { key }));
    assert.equal(all('SELECT * FROM needs_attention_reviews WHERE reopened_by_name = ?', ['Sam Staff']).length, 1);
  } finally {
    server.close();
  }
});

test('the count matches the active list; dismissals are in backups and an older backup keeps them', async () => {
  const server = await startTestServer();
  try {
    const { leadCall } = await setup(server);
    const call = ok(await leadCall('', today));
    ok(await leadCall('', today));
    const list = ok(await server.request('GET', '/needs-attention'));
    assert.equal(ok(await server.request('GET', '/needs-attention/count')).count, list.total);
    ok(await server.request('POST', '/needs-attention/dismiss', { key: `call:${call.id}:booked-lead-no-job-number`, reason: 'ok' }));
    const backup = ok(await server.request('GET', '/export/backup.json'));
    assert.equal(backup.tables.needs_attention_reviews.length, 1);
    const older = JSON.parse(JSON.stringify(backup));
    delete older.tables.needs_attention_reviews;
    ok(await server.request('POST', '/export/restore', older));
    assert.equal(all('SELECT * FROM needs_attention_reviews').length, 1, 'kept when restoring an older backup');
    ok(await server.request('POST', '/export/restore', backup));
    assert.equal(all('SELECT * FROM needs_attention_reviews').length, 1);
  } finally {
    server.close();
  }
});
