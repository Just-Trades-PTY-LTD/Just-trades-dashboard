import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';
import { BACKUP_TABLES, OPTIONAL_BACKUP_TABLES } from '../src/db/backup.js';

// Full backup -> restore round trips (Settings -> Data). A restore must bring
// back every record exactly, link-for-link, on the same CRM or a fresh
// install; must be all-or-nothing; must snapshot the current data first; and
// must never change existing staff accounts or put passwords in a backup.

const DATA_TABLES = [...BACKUP_TABLES, ...OPTIONAL_BACKUP_TABLES];
const dump = () => Object.fromEntries(DATA_TABLES.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const usersDump = () => dbAll('SELECT id, name, email, password_hash, role, active FROM users ORDER BY id');

// Every kind of linked record, including the ones that broke the old restore:
// a knock-back converted by a later sale (jobs.converted_by_sale_id -> sales),
// a Pending Cancellation call (calls.pending_cancellation_id), a follow-up
// with history, reviews with technicians, a changed app setting, and the full
// SA suburb list (which alone takes a backup well past 100kb).
async function seed(server) {
  await server.login();
  const b = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[0].id;
  const L = b.lists;
  const ok = (res) => {
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
    return res.data;
  };
  const tA = ok(await server.request('POST', '/settings/technicians', { name: 'Tech A' }));
  const tB = ok(await server.request('POST', '/settings/technicians', { name: 'Tech B' }));
  ok(await server.request('POST', '/users', { name: 'Staff Sam', email: 'sam@test.local', password: 'password123', role: 'staff' }));
  ok(await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: L.lead_source[0].id, jobNumber: 'R-1', tradeId: plumbing.id }));
  const kb = ok(await server.request('POST', '/tech/new-job', { kind: 'new_job_no_sale', visitDate: '2026-05-02', technicianId: tA.id, jobNumber: 'R-1', tradeId: plumbing.id, jobTypeId, lead: 'Qualified', knockbackReasonId: L.knockback_reason[0].id, suburb: 'Woodcroft (5162)' })).entry;
  const fu = ok(await server.request('POST', '/follow-ups', { jobId: kb.id, dueDate: '2026-05-12' }));
  ok(await server.request('POST', `/follow-ups/${fu.id}/notes`, { note: 'Left a voicemail.' }));
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'R-1', newJobNumber: 'AF-R1', dateLogged: '2026-05-10', creditedTechnicianId: tA.id, invoiceNumber: 'INV-R1', invoiceDate: '2026-05-10', saleValueExGst: 900 }));
  ok(await server.request('POST', '/tech/new-job', { kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: tB.id, jobNumber: 'R-2', tradeId: plumbing.id, jobTypeId, lead: 'Qualified', invoiceNumber: 'INV-R2', invoiceDate: '2026-05-03', saleValueExGst: 500 }));
  ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'R-2', invoiceNumber: 'INV-R2', dateLogged: '2026-05-04', creditedTechnicianId: tA.id, invoiceDate: '2026-05-03', saleValueExGst: 120 }));
  ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'R-2', visitDate: '2026-05-06', technicianId: tA.id, creditedTechnicianId: tB.id }));
  ok(await server.request('POST', '/calls', { callAt: '2026-05-07T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'R-2', cancellationReasonId: L.pending_cancellation_reason?.[0]?.id }));
  ok(await server.request('POST', '/reviews', { reviewDate: '2026-05-08', rating: 5, technicianIds: [tA.id, tB.id], reviewLinkSent: 'Yes', jobNumber: 'R-2' }));
  ok(await server.request('PATCH', '/settings/follow-up-default-due-days', { days: 14 }));

  const d = dump();
  assert.ok(d.jobs.some((j) => j.converted_by_sale_id), 'seed includes a converted knock-back');
  assert.ok(d.calls.some((c) => c.pending_cancellation_id), 'seed includes a Pending Cancellation call');
  assert.ok(d.follow_ups.length && d.follow_up_events.length, 'seed includes a follow-up with history');
  assert.ok(d.app_settings.length, 'seed includes a changed app setting');
}

const report = async (server) => (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data.company;

test('round trip on the same CRM: everything comes back exactly, and a snapshot is taken first', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    assert.ok(JSON.stringify(backup).length > 100 * 1024, 'a realistic backup is bigger than the old 100kb limit');
    const before = dump();
    const usersBefore = usersDump();
    const figuresBefore = await report(server);

    // Change things after the backup, then restore it.
    await server.request('POST', '/calls', { callAt: '2026-05-20T09:00', direction: 'Inbound', callType: 'Not lead' });
    await server.request('PATCH', '/settings/follow-up-default-due-days', { days: 3 });

    const res = await server.request('POST', '/export/restore', backup);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.match(res.data.safetySnapshot, /^backup-.*\.json$/);
    assert.deepEqual(dump(), before, 'every table identical to when the backup was taken');
    assert.deepEqual(usersDump(), usersBefore, 'staff accounts untouched, passwords included');
    assert.deepEqual(await report(server), figuresBefore, 'report figures identical');

    // The snapshot holds the post-backup state (the extra call), so the restore itself can be undone.
    const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(server.dbPath), 'backups', res.data.safetySnapshot), 'utf8'));
    assert.equal(snap.tables.calls.length, before.calls.length + 1);
    const listed = (await server.request('GET', '/export/auto-backups')).data.map((b) => b.filename);
    assert.ok(listed.includes(res.data.safetySnapshot), 'the snapshot shows in the automatic backups list');
  } finally {
    server.close();
  }
});

test('restore onto a fresh install: all records and links come back; missing staff are added inactive', async () => {
  const source = await startTestServer();
  let backup;
  let expected;
  let figures;
  try {
    await seed(source);
    backup = (await source.request('GET', '/export/backup.json')).data;
    expected = dump();
    figures = await report(source);
  } finally {
    source.close();
  }

  const fresh = await startTestServer();
  try {
    await fresh.login();
    const adminBefore = usersDump()[0];
    const res = await fresh.request('POST', '/export/restore', backup);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(dump(), expected);
    assert.deepEqual(await report(fresh), figures);

    const users = usersDump();
    assert.deepEqual(users[0], adminBefore, 'the existing admin account is unchanged');
    const sam = users.find((u) => u.email === 'sam@test.local');
    assert.ok(sam, 'staff account referenced by the records is added');
    assert.equal(sam.active, 0, '...as inactive');
    await fresh.login('sam@test.local', 'password123').then(
      () => assert.fail('a restored account must not be usable until an admin sets a password'),
      () => {},
    );
  } finally {
    fresh.close();
  }
});

test('backups never contain password hashes', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    assert.ok(backup.tables.users.length >= 2);
    assert.ok(backup.tables.users.every((u) => !('password_hash' in u)));
    assert.doesNotMatch(JSON.stringify(backup), /password_hash|scrypt|\$2[aby]\$/);
  } finally {
    server.close();
  }
});

test('a restore never changes existing staff accounts, even if the backup says otherwise', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    const before = usersDump();
    backup.tables.users = backup.tables.users.map((u) => ({ ...u, name: 'Changed', role: 'staff', active: 0 }));
    assert.equal((await server.request('POST', '/export/restore', backup)).status, 200);
    assert.deepEqual(usersDump(), before);
  } finally {
    server.close();
  }
});

test('an older backup (no follow-ups, users or settings, and a missing newer column) still restores', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    const settingsBefore = dump().app_settings;
    delete backup.tables.follow_ups;
    delete backup.tables.follow_up_events;
    delete backup.tables.users;
    delete backup.tables.app_settings;
    backup.tables.jobs = backup.tables.jobs.map(({ suburb, ...rest }) => rest);

    const res = await server.request('POST', '/export/restore', backup);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const after = dump();
    assert.equal(after.jobs.length, backup.tables.jobs.length);
    assert.ok(after.jobs.every((j) => j.suburb === ''), 'a column the backup lacks takes its default');
    assert.equal(after.follow_ups.length, 0, 'tables an old backup never had are left empty, as before');
    assert.deepEqual(after.app_settings, settingsBefore, 'settings kept when the backup has none');
  } finally {
    server.close();
  }
});

test('a backup whose records do not link up is refused and nothing changes', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    const before = dump();
    backup.tables.sales[0] = { ...backup.tables.sales[0], job_id: 99999 };
    const res = await server.request('POST', '/export/restore', backup);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /don't link up \(sales → jobs\)/);
    assert.deepEqual(dump(), before);
  } finally {
    server.close();
  }
});

test('a file that is not a CRM backup is refused and nothing changes', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const before = dump();
    for (const body of [{}, { tables: 'x' }, { tables: { nonsense: [1] } }]) {
      const res = await server.request('POST', '/export/restore', body);
      assert.equal(res.status, 400);
      assert.deepEqual(dump(), before);
    }
  } finally {
    server.close();
  }
});

test('staff cannot restore', async () => {
  const server = await startTestServer();
  try {
    await seed(server);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    await server.login('sam@test.local', 'password123');
    const before = dump();
    assert.equal((await server.request('POST', '/export/restore', backup)).status, 403);
    assert.deepEqual(dump(), before);
  } finally {
    server.close();
  }
});
