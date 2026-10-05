import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun } from '../src/db/index.js';

// Call Back now records two separate Job Numbers, mirroring Quote Approved
// Later's own design:
//   - Original Job Number (job_number) — the job that caused the callback,
//     used to locate/link the original job and auto-populate Trade/Job
//     Type/Credited Technician. Mandatory, but — unlike Quote Approved
//     Later/Upsell — never required to actually match an existing job: a
//     Call Back may be logged before the original job is in the system, and
//     is simply left unlinked (job_id NULL) until it is.
//   - New Callback Job Number (new_job_number) — the separate AroFlo JN
//     created once the callback attendance is actually booked. Optional
//     even at creation. Reference/search only: never linked to a job row,
//     never creates or counts as a Total/Qualified Job.
// Credited (original work) Technician is auto-populated from whoever
// actually completed the original work — the matched job's own attending
// technician, or its separate Install Technician when that job says the
// work was completed on a different day — never from who made the sale.
// See routes/techSales.js's originalWorkTechnicianId() for the exact rule.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const techOriginal = (await server.request('POST', '/settings/technicians', { name: 'CB Tech Original' })).data;
  const techInstall = (await server.request('POST', '/settings/technicians', { name: 'CB Tech Install' })).data;
  return { bundle, plumbing, jobTypeId, techOriginal, techInstall };
}

async function jobCompletedSameVisit(server, { technicianId, plumbing, jobTypeId, jobNumber, visitDate = '2026-06-01', lead = 'Qualified' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead,
    invoiceNumber: `INV-${jobNumber}`,
    invoiceDate: visitDate,
    saleValueExGst: 500,
    workCompletion: 'Completed on this visit',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

async function jobCompletedDifferentDay(server, { technicianId, installTechnicianId, plumbing, jobTypeId, jobNumber, visitDate = '2026-06-01' }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made',
    visitDate,
    technicianId,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Qualified',
    invoiceNumber: `INV-${jobNumber}`,
    invoiceDate: visitDate,
    saleValueExGst: 500,
    workCompletion: 'Install scheduled — different day',
    installTechnicianId,
    installDate: '2026-06-05',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('Editing a Call Back to clear Credited Technician falls back to the attending technician when the job was completed on the same visit', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techInstall } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-SAMEDAY-2' });

    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-SAMEDAY-2',
      visitDate: '2026-06-10',
      technicianId: techInstall.id,
      creditedTechnicianId: techInstall.id,
    });
    assert.equal(created.status, 201);

    const cleared = await server.request('PATCH', `/tech/call-backs/${created.data.entry.id}`, { creditedTechnicianId: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.creditedTechnicianId, techOriginal.id, "falls back to the job's own attending technician, not the installer");
  } finally {
    server.close();
  }
});

test("Editing a Call Back to clear Credited Technician falls back to the Install Technician when the job says work was completed on a different day", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techInstall } = await setup(server);
    await jobCompletedDifferentDay(server, {
      technicianId: techOriginal.id,
      installTechnicianId: techInstall.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-CB-DIFFDAY-1',
    });

    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-DIFFDAY-1',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(created.status, 201);

    const cleared = await server.request('PATCH', `/tech/call-backs/${created.data.entry.id}`, { creditedTechnicianId: '' });
    assert.equal(cleared.status, 200);
    assert.equal(
      cleared.data.creditedTechnicianId,
      techInstall.id,
      'falls back to whoever actually completed the work on the different day, not who made the sale'
    );
  } finally {
    server.close();
  }
});

test('The Credited Technician fallback falls back to the attending technician when the job says a different day but never recorded an Install Technician', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    const res = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-06-01',
      technicianId: techOriginal.id,
      jobNumber: 'JN-CB-DIFFDAY-NOINSTALL',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Qualified',
      invoiceNumber: 'INV-NOINSTALL',
      invoiceDate: '2026-06-01',
      saleValueExGst: 500,
      workCompletion: 'Install scheduled — different day',
      // installTechnicianId deliberately omitted.
    });
    assert.equal(res.status, 201);

    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-DIFFDAY-NOINSTALL',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(created.status, 201);

    const cleared = await server.request('PATCH', `/tech/call-backs/${created.data.entry.id}`, { creditedTechnicianId: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.creditedTechnicianId, techOriginal.id, 'never left blank — falls back sensibly to the attending technician');
  } finally {
    server.close();
  }
});

test('Changing the Call Back Credited Technician never alters the original job\'s own technician, sale, or any other information', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal, techInstall } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-UNCHANGED' });

    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-UNCHANGED',
      visitDate: '2026-06-10',
      technicianId: techInstall.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(created.status, 201);

    await server.request('PATCH', `/tech/call-backs/${created.data.entry.id}`, { creditedTechnicianId: techInstall.id });

    const entries = (await server.request('GET', '/tech/entries')).data;
    const originalJob = entries.find((e) => e.jobNumber === 'JN-CB-UNCHANGED' && e.kind === 'new_job_sale_made');
    assert.equal(originalJob.technicianId, techOriginal.id, "the original job's own technician is untouched");
    assert.equal(originalJob.saleValueExGst, 500, "the original job's own sale is untouched");
  } finally {
    server.close();
  }
});

test('A brand-new Call Back is accepted even when the Original Job Number matches nothing yet — no hard rejection', async () => {
  const server = await startTestServer();
  try {
    const { techOriginal } = await setup(server);
    const res = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-NEVER-LOGGED',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(res.status, 201, 'a Call Back may be logged before the original job is even in the system');
    assert.equal(res.data.entry.jobId, null, 'left unlinked — no job row to link to yet');
  } finally {
    server.close();
  }
});

test('New Callback Job Number is optional on creation, and duplicate protection is scoped only to it — never confused with the Original Job Number', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-DUPE-A' });
    await jobCompletedSameVisit(server, {
      technicianId: techOriginal.id,
      plumbing,
      jobTypeId,
      jobNumber: 'JN-CB-DUPE-B',
      visitDate: '2026-06-02',
    });

    // No New Callback Job Number at all — allowed.
    const noNewJn = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-DUPE-A',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(noNewJn.status, 201);
    assert.equal(noNewJn.data.entry.newJobNumber, '');

    // A second, distinct callback on the SAME original job, with its own New
    // Callback JN — a legitimate second callback visit, never flagged as a
    // "duplicate" merely for sharing the Original Job Number.
    const sameJobSecondCallback = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-DUPE-A',
      visitDate: '2026-06-15',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
      newJobNumber: 'AROFLO-CB-SHARED',
    });
    assert.equal(sameJobSecondCallback.status, 201, 'a second genuine callback on the same original job must never be blocked');

    // A DIFFERENT original job trying to reuse that same New Callback JN —
    // blocked, since that's a real AroFlo identifier and must stay unique.
    const dupeNewJn = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-DUPE-B',
      visitDate: '2026-06-16',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
      newJobNumber: 'AROFLO-CB-SHARED',
    });
    assert.equal(dupeNewJn.status, 400);
    assert.match(dupeNewJn.data.error, /AROFLO-CB-SHARED/);
    assert.match(dupeNewJn.data.error, /already used/);

    // Editing a call back to keep its OWN existing New Callback JN (no real
    // change) must never be blocked by the exclude-self check.
    const resaveSelf = await server.request('PATCH', `/tech/call-backs/${sameJobSecondCallback.data.entry.id}`, {
      newJobNumber: 'AROFLO-CB-SHARED',
      comments: 'no-op re-save',
    });
    assert.equal(resaveSelf.status, 200, "re-saving a call back with its own unchanged New Callback JN is never blocked");
  } finally {
    server.close();
  }
});

test('Searching by either the Original or the New Callback Job Number locates the same Call Back entry', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-SEARCH' });
    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-SEARCH',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
      newJobNumber: 'AROFLO-CB-SEARCH',
    });
    assert.equal(created.status, 201);
    const id = created.data.entry.id;

    const byOriginal = (await server.request('GET', '/tech/entries?jobNumber=JN-CB-SEARCH')).data;
    assert.ok(byOriginal.some((e) => e.kind === 'call_back' && e.id === id), 'found by Original Job Number');

    const byNew = (await server.request('GET', '/tech/entries?jobNumber=AROFLO-CB-SEARCH')).data;
    assert.ok(byNew.some((e) => e.kind === 'call_back' && e.id === id), 'found by New Callback Job Number');
  } finally {
    server.close();
  }
});

test('The original job and the linked Call Back are each visible and cross-linkable from the other', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    const job = await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-CROSSLINK' });
    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-CROSSLINK',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
    });
    assert.equal(created.status, 201);

    const entries = (await server.request('GET', '/tech/entries')).data;
    const jobEntry = entries.find((e) => e.id === job.id && e.kind === 'new_job_sale_made');
    const callBackEntry = entries.find((e) => e.id === created.data.entry.id && e.kind === 'call_back');

    assert.equal(jobEntry.relatedCallBackCount, 1, 'the original job shows exactly one linked callback');
    assert.equal(callBackEntry.jobId, job.id, 'the call back carries the matched original job id, for its own "View original job" link');
  } finally {
    server.close();
  }
});

test('A Call Back never creates a Total Job, Qualified Job, sale, or knockback, and the existing callback reporting continues to count it only as a callback', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-NODOUBLE' });

    const before = (await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30')).data;
    assert.equal(before.company.jobsAttended, 1);
    assert.equal(before.company.sales, 1);

    await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-NODOUBLE',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
      newJobNumber: 'AROFLO-CB-NODOUBLE',
    });

    const after = (await server.request('GET', '/reports/tech?from=2026-06-01&to=2026-06-30')).data;
    assert.equal(after.company.jobsAttended, 1, 'Total Jobs unaffected — the callback and its New Callback JN never count as a job');
    assert.equal(after.company.qualifiedJobs, 1, 'Qualified Jobs unaffected');
    assert.equal(after.company.sales, 1, 'Sales unaffected — a callback is never a sale');
    assert.equal(after.company.actualKnockbacks, 0, 'never a knock-back');
    assert.equal(after.company.callBacks, 1, 'counted exactly once, as a callback only');
  } finally {
    server.close();
  }
});

test('A legacy Call Back record saved before this feature existed (no New Callback Job Number) stays viewable and editable, with new_job_number simply blank', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    const job = await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-LEGACY' });

    // Simulate a record saved before new_job_number existed — inserted
    // directly, exactly like real pre-existing data on disk, never created
    // through the now-extended POST route.
    const { lastInsertRowid: callBackId } = dbRun(
      `INSERT INTO call_backs (job_id, job_number, visit_date, attending_technician_id, credited_technician_id, comments, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [job.id, 'JN-CB-LEGACY', '2026-06-10', techOriginal.id, techOriginal.id, 'legacy record', 1]
    );

    const entries = (await server.request('GET', '/tech/entries')).data;
    const legacy = entries.find((e) => e.id === callBackId && e.kind === 'call_back');
    assert.ok(legacy, 'the legacy record must still be viewable');
    assert.equal(legacy.newJobNumber, '', 'New Callback Job Number is blank, never invented');

    // Editing it to add a New Callback Job Number must not disturb anything else.
    const patched = await server.request('PATCH', `/tech/call-backs/${callBackId}`, { newJobNumber: 'AROFLO-CB-LEGACY' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.newJobNumber, 'AROFLO-CB-LEGACY');
    assert.equal(patched.data.jobNumber, 'JN-CB-LEGACY', 'the original link/JN is unchanged');
  } finally {
    server.close();
  }
});

test('Admin activity history records a change when either the Original or the New Callback Job Number is edited', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, techOriginal } = await setup(server);
    await jobCompletedSameVisit(server, { technicianId: techOriginal.id, plumbing, jobTypeId, jobNumber: 'JN-CB-AUDIT' });
    const created = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-AUDIT',
      visitDate: '2026-06-10',
      technicianId: techOriginal.id,
      creditedTechnicianId: techOriginal.id,
      newJobNumber: 'AROFLO-CB-AUDIT',
    });
    const id = created.data.entry.id;

    const patched = await server.request('PATCH', `/tech/call-backs/${id}`, { newJobNumber: 'AROFLO-CB-AUDIT-CHANGED' });
    assert.equal(patched.status, 200);

    const history = (await server.request('GET', `/tech/entries/call_back/${id}/history`)).data;
    const newJnChange = history.find((h) => h.changes.new_job_number);
    assert.ok(newJnChange, 'a change to New Callback Job Number must appear in the audit history');
    assert.deepEqual(newJnChange.changes.new_job_number, { from: 'AROFLO-CB-AUDIT', to: 'AROFLO-CB-AUDIT-CHANGED' });
  } finally {
    server.close();
  }
});
