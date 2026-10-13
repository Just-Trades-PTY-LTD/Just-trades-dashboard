import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Quote Follow-up trial — a purely operational reminder to call a customer
// back about a quote after a knock-back. See routes/followUps.js's own file
// comment: nothing here is ever read by services/reports.js, so creating,
// rescheduling, closing or reopening a follow-up must never move any
// Total/Qualified Jobs, Sales, Knock-backs, Conversion Rate, Average Sale, or
// any technician figure. Must satisfy, in full:
//   - created only against a genuine knock-back job, at most one active per job
//   - default due date = attendance date + configured days, shifted off a weekend
//   - due date editable at creation and again later (reschedule, never duplicates)
//   - notes/reschedule/close/reopen all recorded as an append-only event history
//   - closing requires one of the five fixed outcomes
//   - a Quote Approved Later sale for the same Original JN auto-closes the
//     follow-up as Quote Approved, and reopening is manual-only

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const tech = (await server.request('POST', '/settings/technicians', { name: 'Follow-up Tech' })).data;
  const reason = bundle.lists.knockback_reason[0];
  return { bundle, plumbing, jobTypeId, tech, reason };
}

async function knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber, visitDate = '2026-06-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId: tech.id,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Qualified',
    knockbackReasonId: reason.id,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.entry.knockback, true);
  return res.data.entry;
}

test('a follow-up can only be created for a genuine knock-back job, defaults the due date correctly, and blocks a second active follow-up on the same job', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing, jobTypeId, reason } = await setup(server);

    // Non-knockback (sale made) job — rejected.
    const saleJob = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made',
        visitDate: '2026-06-01',
        technicianId: tech.id,
        jobNumber: 'FU-SALE-1',
        tradeId: plumbing.id,
        jobTypeId,
        lead: 'Qualified',
        invoiceNumber: 'INV-FU-1',
        invoiceDate: '2026-06-01',
        saleValueExGst: 500,
      })
    ).data.entry;
    const rejected = await server.request('POST', '/follow-ups', { jobId: saleJob.id, dueDate: '2026-06-11' });
    assert.equal(rejected.status, 400);

    // Default due date: 2026-06-01 (Monday) + 10 days = 2026-06-11 (Thursday) — no weekend shift needed.
    const defaultRes = await server.request('GET', '/follow-ups/default-due-date?attendanceDate=2026-06-01');
    assert.equal(defaultRes.status, 200);
    assert.equal(defaultRes.data.dueDate, '2026-06-11');
    assert.equal(defaultRes.data.defaultDueDays, 10);

    const job = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-KB-1' });
    const created = await server.request('POST', '/follow-ups', { jobId: job.id, dueDate: defaultRes.data.dueDate });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.jobNumber, 'FU-KB-1');
    assert.equal(created.data.dueDate, '2026-06-11');
    assert.equal(created.data.status, 'active');
    assert.equal(created.data.suburb, job.suburb || '');
    assert.equal(created.data.events.length, 1);
    assert.equal(created.data.events[0].kind, 'created');

    // A second attempt on the same job is rejected and points at the existing one.
    const dup = await server.request('POST', '/follow-ups', { jobId: job.id, dueDate: '2026-06-15' });
    assert.equal(dup.status, 400);
    assert.equal(dup.data.existingFollowUpId, created.data.id);
  } finally {
    server.close();
  }
});

test('the default due date shifts off a weekend onto the following Monday', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    // 2026-06-04 is a Thursday; +10 days = 2026-06-14, a Sunday -> shifts to Monday 2026-06-15.
    const res = await server.request('GET', '/follow-ups/default-due-date?attendanceDate=2026-06-04');
    assert.equal(res.status, 200);
    assert.equal(res.data.dueDate, '2026-06-15');
  } finally {
    server.close();
  }
});

test('the configured default due-days setting is editable in Settings and used for new defaults', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const before = await server.request('GET', '/follow-ups/default-due-date?attendanceDate=2026-06-01');
    assert.equal(before.data.defaultDueDays, 10);

    const update = await server.request('PATCH', '/settings/follow-up-default-due-days', { days: 5 });
    assert.equal(update.status, 200, JSON.stringify(update.data));
    assert.equal(update.data.followUpDefaultDueDays, 5);

    const after = await server.request('GET', '/follow-ups/default-due-date?attendanceDate=2026-06-01');
    assert.equal(after.data.defaultDueDays, 5);
    // 2026-06-01 (Monday) + 5 days = 2026-06-06, a Saturday -> shifts to Monday 2026-06-08.
    assert.equal(after.data.dueDate, '2026-06-08');

    const bundle = (await server.request('GET', '/settings/bundle')).data;
    assert.equal(bundle.followUpDefaultDueDays, 5);

    const rejected = await server.request('PATCH', '/settings/follow-up-default-due-days', { days: 0 });
    assert.equal(rejected.status, 400);
  } finally {
    server.close();
  }
});

test('notes, reschedule, close and reopen are all recorded as an append-only event history', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing, jobTypeId, reason } = await setup(server);
    const job = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-KB-2' });
    const created = (await server.request('POST', '/follow-ups', { jobId: job.id, dueDate: '2026-06-11' })).data;

    const noted = await server.request('POST', `/follow-ups/${created.id}/notes`, { note: 'Left a voicemail.' });
    assert.equal(noted.status, 200, JSON.stringify(noted.data));
    assert.equal(noted.data.events.length, 2);
    assert.equal(noted.data.events[1].kind, 'note');
    assert.equal(noted.data.events[1].note, 'Left a voicemail.');
    assert.ok(noted.data.events[1].byName);

    const rescheduled = await server.request('PATCH', `/follow-ups/${created.id}/due-date`, {
      dueDate: '2026-06-18',
      note: 'Customer asked to call back next week.',
    });
    assert.equal(rescheduled.status, 200);
    assert.equal(rescheduled.data.dueDate, '2026-06-18');
    assert.equal(rescheduled.data.id, created.id, 'reschedule updates the same task, never creates a new one');
    const rescheduleEvent = rescheduled.data.events.find((e) => e.kind === 'reschedule');
    assert.equal(rescheduleEvent.previousDueDate, '2026-06-11');
    assert.equal(rescheduleEvent.newDueDate, '2026-06-18');

    const invalidClose = await server.request('PATCH', `/follow-ups/${created.id}/close`, { outcome: 'not_a_real_outcome' });
    assert.equal(invalidClose.status, 400);

    const closed = await server.request('PATCH', `/follow-ups/${created.id}/close`, {
      outcome: 'unable_to_contact',
      note: 'No answer after three attempts.',
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.status, 'closed');
    assert.equal(closed.data.closedOutcome, 'unable_to_contact');

    // Closed follow-ups remain searchable by job number/suburb.
    const closedList = await server.request('GET', '/follow-ups?status=closed&q=FU-KB-2');
    assert.equal(closedList.status, 200);
    assert.ok(closedList.data.entries.some((e) => e.id === created.id));

    // No longer appears in the active/outstanding list.
    const activeList = await server.request('GET', '/follow-ups');
    assert.ok(!activeList.data.entries.some((e) => e.id === created.id));

    const reopened = await server.request('PATCH', `/follow-ups/${created.id}/reopen`, { note: 'Customer called back.' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.status, 'active');
    assert.equal(reopened.data.closedOutcome, '');
    const kinds = reopened.data.events.map((e) => e.kind);
    assert.deepEqual(kinds, ['created', 'note', 'reschedule', 'closed', 'reopened'], 'every event stays, in order — nothing overwritten');
  } finally {
    server.close();
  }
});

test('an outstanding follow-up shows in the overdue/due-today/upcoming buckets correctly, sorted by due date', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing, jobTypeId, reason } = await setup(server);
    const past = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-OVERDUE' });
    const future = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-UPCOMING' });

    const overdueFollowUp = (await server.request('POST', '/follow-ups', { jobId: past.id, dueDate: '2020-01-01' })).data;
    const upcomingFollowUp = (await server.request('POST', '/follow-ups', { jobId: future.id, dueDate: '2099-01-01' })).data;

    const list = await server.request('GET', '/follow-ups');
    assert.equal(list.status, 200);
    const overdueEntry = list.data.entries.find((e) => e.id === overdueFollowUp.id);
    const upcomingEntry = list.data.entries.find((e) => e.id === upcomingFollowUp.id);
    assert.equal(overdueEntry.bucket, 'overdue');
    assert.equal(upcomingEntry.bucket, 'upcoming');
    assert.ok(list.data.overdueCount >= 1);
    // Sorted by due date ascending — the overdue one (2020) must come before the upcoming one (2099).
    const overdueIndex = list.data.entries.findIndex((e) => e.id === overdueFollowUp.id);
    const upcomingIndex = list.data.entries.findIndex((e) => e.id === upcomingFollowUp.id);
    assert.ok(overdueIndex < upcomingIndex);
  } finally {
    server.close();
  }
});

test('a Quote Approved Later sale on the same Original JN automatically closes the active follow-up as Quote Approved, and reopening afterwards is manual-only', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing, jobTypeId, reason } = await setup(server);
    const job = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-APPROVED-LATER' });
    const followUp = (await server.request('POST', '/follow-ups', { jobId: job.id, dueDate: '2026-06-11' })).data;

    const approvedLater = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'FU-APPROVED-LATER',
      newJobNumber: 'FU-APPROVED-LATER-NEW',
      dateLogged: '2026-06-05',
      creditedTechnicianId: tech.id,
      tradeId: plumbing.id,
      jobTypeId,
      invoiceNumber: 'INV-FU-APPROVED',
      invoiceDate: '2026-06-05',
      saleValueExGst: 800,
    });
    assert.equal(approvedLater.status, 201, JSON.stringify(approvedLater.data));

    const afterApproval = await server.request('GET', `/follow-ups/${followUp.id}`);
    assert.equal(afterApproval.data.status, 'closed');
    assert.equal(afterApproval.data.closedOutcome, 'quote_approved');
    const closeEvent = afterApproval.data.events.find((e) => e.kind === 'closed');
    assert.ok(closeEvent, 'the automatic close is recorded in the event history like any other close');

    // Manual-only reopen: nothing automatically reopens it even though the
    // sale that closed it still exists — this is deliberately deferred.
    const stillClosed = await server.request('GET', '/follow-ups?status=closed');
    assert.ok(stillClosed.data.entries.some((e) => e.id === followUp.id));
    const reopened = await server.request('PATCH', `/follow-ups/${followUp.id}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.status, 'active');
  } finally {
    server.close();
  }
});

test('Quote Follow-up activity never changes any Total/Qualified Jobs, Sales, Knock-back, Conversion, or technician figure', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing, jobTypeId, reason } = await setup(server);
    const job = await knockbackJob(server, { tech, plumbing, jobTypeId, reason, jobNumber: 'FU-REPORT-SAFE', visitDate: '2026-07-01' });

    const before = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;

    const followUp = (await server.request('POST', '/follow-ups', { jobId: job.id, dueDate: '2026-07-11' })).data;
    await server.request('POST', `/follow-ups/${followUp.id}/notes`, { note: 'Called, no answer.' });
    await server.request('PATCH', `/follow-ups/${followUp.id}/due-date`, { dueDate: '2026-07-18' });
    await server.request('PATCH', `/follow-ups/${followUp.id}/close`, { outcome: 'quote_rejected' });
    await server.request('PATCH', `/follow-ups/${followUp.id}/reopen`);

    const after = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;

    assert.deepEqual(after.company, before.company, 'no company-level figure moved because of any follow-up activity');
    assert.deepEqual(after.byTechnician, before.byTechnician, 'no per-technician figure moved because of any follow-up activity');
  } finally {
    server.close();
  }
});
