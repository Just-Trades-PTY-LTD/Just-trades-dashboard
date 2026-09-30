import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestServer } from './helpers.js';
import { openDb, run as dbRun, get as dbGet } from '../src/db/index.js';

// Linking Calls & Contacts' suburb to Technician & Sales: a brand-new job's
// Suburb is auto-populated from the earliest Calls & Contacts record sharing
// its Job Number (the linked/original booking, never a later, unrelated
// contact) — both live (an explicit backend fallback on creation, so it
// never depends on the client's own lookup having actually fired) and, for
// jobs that already existed when this shipped, via a one-time additive
// migration. Always editable afterwards; never guessed when no reliable
// match exists.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  return { plumbing, jobTypeId: plumbing.jobTypes[0].id };
}

async function logCall(server, { jobNumber, suburb, callAt }) {
  const res = await server.request('POST', '/calls', {
    callAt,
    direction: 'Inbound',
    callType: 'Lead',
    booked: 'Yes',
    jobNumber,
    suburb,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('/lookup/call finds no match for an unknown Job Number', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const res = await server.request('GET', '/lookup/call?jn=JN-NO-SUCH-CALL');
    assert.equal(res.status, 200);
    assert.equal(res.data.found, false);
  } finally {
    server.close();
  }
});

test("A brand-new job auto-populates Suburb from the matching call, but an explicit value in the request always wins", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId } = await setup(server);
    await logCall(server, { jobNumber: 'JN-SUBURB-1', suburb: 'Adelaide (5000)', callAt: '2026-06-01T09:00' });

    const lookup = await server.request('GET', '/lookup/call?jn=JN-SUBURB-1');
    assert.equal(lookup.data.found, true);
    assert.equal(lookup.data.suburb, 'Adelaide (5000)');

    // No explicit suburb -> falls back to the matching call's.
    const auto = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-02',
      technicianId: (await server.request('POST', '/settings/technicians', { name: 'Suburb Tech' })).data.id,
      jobNumber: 'JN-SUBURB-1',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
    });
    assert.equal(auto.status, 201, JSON.stringify(auto.data));
    assert.equal(auto.data.entry.suburb, 'Adelaide (5000)');

    // An explicit suburb in the request overrides the matched call's.
    const explicit = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-02',
      technicianId: auto.data.entry.technicianId,
      jobNumber: 'JN-SUBURB-2',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
      suburb: 'Norwood (5067)',
    });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.data.entry.suburb, 'Norwood (5067)');
  } finally {
    server.close();
  }
});

test('No matching call and no explicit suburb: the field stays blank rather than guessing', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId } = await setup(server);
    const tech = (await server.request('POST', '/settings/technicians', { name: 'No Match Tech' })).data;
    const res = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-02',
      technicianId: tech.id,
      jobNumber: 'JN-SUBURB-NOMATCH',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.entry.suburb, '');
  } finally {
    server.close();
  }
});

test('Multiple calls share the same Job Number: the earliest (original booking) call\'s suburb is used, never a later, unrelated contact\'s', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId } = await setup(server);
    // Logged out of chronological order on purpose — the ORIGINAL booking
    // (earliest call_at) must still win regardless of insertion order.
    await logCall(server, { jobNumber: 'JN-SUBURB-MULTI', suburb: 'Later Suburb (5999)', callAt: '2026-06-10T09:00' });
    await logCall(server, { jobNumber: 'JN-SUBURB-MULTI', suburb: 'Original Suburb (5001)', callAt: '2026-06-01T09:00' });
    await logCall(server, { jobNumber: 'JN-SUBURB-MULTI', suburb: 'Middle Suburb (5500)', callAt: '2026-06-05T09:00' });

    const lookup = await server.request('GET', '/lookup/call?jn=JN-SUBURB-MULTI');
    assert.equal(lookup.data.suburb, 'Original Suburb (5001)', 'the earliest call by call_at, not insertion order or a later one');

    const tech = (await server.request('POST', '/settings/technicians', { name: 'Multi Call Tech' })).data;
    const job = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-11',
      technicianId: tech.id,
      jobNumber: 'JN-SUBURB-MULTI',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
    });
    assert.equal(job.data.entry.suburb, 'Original Suburb (5001)');
  } finally {
    server.close();
  }
});

test("The earliest call having no suburb recorded never falls through to a later contact's suburb", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId } = await setup(server);
    await logCall(server, { jobNumber: 'JN-SUBURB-BLANK-ORIGINAL', suburb: '', callAt: '2026-06-01T09:00' });
    await logCall(server, { jobNumber: 'JN-SUBURB-BLANK-ORIGINAL', suburb: 'Some Later Suburb (5100)', callAt: '2026-06-05T09:00' });

    const lookup = await server.request('GET', '/lookup/call?jn=JN-SUBURB-BLANK-ORIGINAL');
    assert.equal(lookup.data.found, true, 'a call was found');
    assert.equal(lookup.data.suburb, '', "the ORIGINAL call's own (blank) suburb, never the later one's");

    const tech = (await server.request('POST', '/settings/technicians', { name: 'Blank Original Tech' })).data;
    const job = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-06',
      technicianId: tech.id,
      jobNumber: 'JN-SUBURB-BLANK-ORIGINAL',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
    });
    assert.equal(job.data.entry.suburb, '', 'stays blank for manual selection rather than substituting a later contact\'s suburb');
  } finally {
    server.close();
  }
});

test('Suburb is editable after creation, including clearing it back to blank, and shows in the unified Job History entry', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId } = await setup(server);
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Edit Suburb Tech' })).data;
    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-06-02',
      technicianId: tech.id,
      jobNumber: 'JN-SUBURB-EDIT',
      tradeId: plumbing.id,
      jobTypeId,
      lead: 'Not Qualified',
      suburb: 'Glenelg (5045)',
    });
    assert.equal(created.data.entry.suburb, 'Glenelg (5045)');

    const entries = (await server.request('GET', '/tech/entries')).data;
    const listed = entries.find((e) => e.id === created.data.entry.id && e.kind === 'new_job_no_sale');
    assert.equal(listed.suburb, 'Glenelg (5045)', 'shows in the unified Job History list');

    const patched = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, { suburb: 'Unley (5061)' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.suburb, 'Unley (5061)', 'a correction is saved');

    const cleared = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, { suburb: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.suburb, '', 'can be cleared back to blank for manual re-selection');
  } finally {
    server.close();
  }
});

test('One-time backfill: populates Suburb on a pre-existing job from its earliest matching call, but only where the match is reliable, and only ever once', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-')), 'backfill.sqlite');
  try {
    // First boot: fresh schema, no data yet — the backfill migration no-ops
    // and marks itself done, exactly as it would on a genuine first deploy.
    openDb(dbPath, { allowFreshInit: true });

    // Simulate data that already existed before this feature shipped:
    // inserted directly, never through the now-guarded routes.
    // created_by_user_id is left null throughout (no seeded user exists on
    // this bare openDb() call) — it's nullable and irrelevant here.
    dbRun(
      `INSERT INTO calls (call_at, direction, call_type, booked, job_number, suburb)
       VALUES (?, 'Inbound', 'Lead', 'Yes', ?, ?)`,
      ['2026-01-01T09:00', 'JN-BACKFILL-1', 'Backfilled Suburb (5200)']
    );
    // A later, unrelated call on the same JN — must never win over the
    // earlier one above.
    dbRun(
      `INSERT INTO calls (call_at, direction, call_type, booked, job_number, suburb)
       VALUES (?, 'Inbound', 'Call back', '', ?, ?)`,
      ['2026-01-05T09:00', 'JN-BACKFILL-1', 'Wrong Later Suburb (5999)']
    );
    // A job with no matching call at all — must stay blank forever.
    dbRun(
      `INSERT INTO jobs (job_number, visit_date, lead, comments, suburb)
       VALUES (?, ?, 'Not Qualified', '', '')`,
      ['JN-BACKFILL-NOMATCH', '2026-01-02']
    );
    // A job that already has a non-blank suburb of its own — must never be
    // overwritten, even though a matching call with a different suburb exists.
    dbRun(
      `INSERT INTO calls (call_at, direction, call_type, booked, job_number, suburb)
       VALUES (?, 'Inbound', 'Lead', 'Yes', ?, ?)`,
      ['2026-01-01T09:00', 'JN-BACKFILL-ALREADYSET', 'Should Never Be Used (5300)']
    );
    const { lastInsertRowid: alreadySetJobId } = dbRun(
      `INSERT INTO jobs (job_number, visit_date, lead, comments, suburb)
       VALUES (?, ?, 'Not Qualified', '', ?)`,
      ['JN-BACKFILL-ALREADYSET', '2026-01-02', 'Manually Set Already (5400)']
    );
    // The job the backfill should actually act on — inserted with the
    // blank default suburb every legacy row would have had.
    const { lastInsertRowid: targetJobId } = dbRun(
      `INSERT INTO jobs (job_number, visit_date, lead, comments, suburb)
       VALUES (?, ?, 'Not Qualified', '', '')`,
      ['JN-BACKFILL-1', '2026-01-02']
    );

    // Undo the "already ran" marker to simulate this being the very first
    // boot after the backfill migration shipped, now that the pre-existing
    // data above is in place (in reality this data would already have been
    // there the one time this migration ever actually runs).
    dbRun("DELETE FROM one_time_migrations WHERE id = 'backfill_job_suburb_from_calls'");

    // Second boot: the backfill now runs against that pre-existing data.
    openDb(dbPath);

    const target = dbGet('SELECT suburb FROM jobs WHERE id = ?', [targetJobId]);
    assert.equal(target.suburb, 'Backfilled Suburb (5200)', "backfilled from the earliest matching call, never the later one's suburb");

    const noMatch = dbGet("SELECT suburb FROM jobs WHERE job_number = 'JN-BACKFILL-NOMATCH'");
    assert.equal(noMatch.suburb, '', 'left blank — no matching call at all, never guessed');

    const alreadySet = dbGet('SELECT suburb FROM jobs WHERE id = ?', [alreadySetJobId]);
    assert.equal(alreadySet.suburb, 'Manually Set Already (5400)', 'a non-blank suburb is never overwritten by the backfill');

    // Third boot: someone now manually clears the backfilled job's suburb —
    // a later boot must never re-apply the backfill and revert that choice.
    dbRun('UPDATE jobs SET suburb = ? WHERE id = ?', ['', targetJobId]);
    openDb(dbPath);
    const afterManualClear = dbGet('SELECT suburb FROM jobs WHERE id = ?', [targetJobId]);
    assert.equal(afterManualClear.suburb, '', 'once the one-time migration has run, it never re-fires and re-fills a value someone deliberately cleared');
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
