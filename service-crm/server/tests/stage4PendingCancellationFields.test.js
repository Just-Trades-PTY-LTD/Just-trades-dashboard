import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addPendingCancellationStage4Columns, PENDING_CANCELLATION_STAGE4_COLUMNS, all as dbAll } from '../src/db/index.js';
import { startTestServer } from './helpers.js';

// Stage 4: database-only. New optional Pending Cancellation fields; nothing
// reads or writes them yet.
const NEW = PENDING_CANCELLATION_STAGE4_COLUMNS.map(([n]) => n);
const MONEY = ['original_sale_value_ex_gst', 'aroflo_invoice_value_ex_gst', 'lost_value_ex_gst'];
// The table exactly as it was before Stage 4.
const OLD_TABLE = `CREATE TABLE pending_cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  sale_id INTEGER,
  job_number TEXT NOT NULL,
  date_logged TEXT NOT NULL,
  credited_technician_id INTEGER,
  trade_id INTEGER,
  reason_id INTEGER,
  comments TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function oldDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(OLD_TABLE);
  db.prepare("INSERT INTO pending_cancellations (sale_id, job_number, date_logged, credited_technician_id, trade_id, reason_id, comments, created_at, updated_at) VALUES (5, '2400', '2026-10-01', 3, 2, 9, 'Customer cancelled', '2026-10-01 10:00:00', '2026-10-01 10:00:00')").run();
  db.prepare("INSERT INTO pending_cancellations (job_number, date_logged, archived) VALUES ('2401', '2026-10-02', 1)").run();
  return db;
}
const rows = (db) => db.prepare('SELECT * FROM pending_cancellations ORDER BY id').all().map((r) => ({ ...r }));

test('migration on the old table: adds every field, blank or NULL (never 0); existing values untouched; safe to run again', () => {
  const db = oldDb();
  const before = rows(db);
  addPendingCancellationStage4Columns(db);
  const after = rows(db);
  const cols = db.prepare('PRAGMA table_info(pending_cancellations)').all();
  for (const n of NEW) assert.ok(cols.some((c) => c.name === n), n);
  after.forEach((r, i) => {
    const old = Object.fromEntries(Object.keys(before[i]).map((k) => [k, r[k]]));
    assert.deepEqual(old, before[i], 'every existing value unchanged');
    for (const n of NEW) assert.ok(r[n] === '' || r[n] === null, `${n} starts blank/NULL`);
    for (const m of MONEY) assert.equal(r[m], null, `${m} is NULL, not 0`);
    assert.equal(r.superseded_by_id, null);
  });
  // Money uses the CRM's existing ex-GST format (REAL), but optional.
  for (const m of MONEY) {
    const c = cols.find((x) => x.name === m);
    assert.deepEqual([c.type, c.notnull, c.dflt_value], ['REAL', 0, null], m);
  }
  // Second and third runs change nothing.
  addPendingCancellationStage4Columns(db);
  addPendingCancellationStage4Columns(db);
  assert.equal(db.prepare('PRAGMA table_info(pending_cancellations)').all().length, cols.length);
  assert.deepEqual(rows(db), after);
});

test('superseded_by_id: only another Pending Cancellation, never itself; superseding keeps the earlier record; deleting the later one only clears the link', () => {
  const db = oldDb();
  addPendingCancellationStage4Columns(db);
  db.exec("INSERT INTO pending_cancellations (job_number, date_logged, invoice_number, lost_value_ex_gst, lost_value_basis) VALUES ('2400', '2026-10-05', '2181', 4754.0, 'whole_sale')");
  const earlier = rows(db)[0];
  const later = rows(db)[2];
  assert.throws(() => db.prepare('UPDATE pending_cancellations SET superseded_by_id = 999 WHERE id = ?').run(earlier.id), /FOREIGN KEY/, 'must be an existing Pending Cancellation');
  assert.throws(() => db.prepare('UPDATE pending_cancellations SET superseded_by_id = id WHERE id = ?').run(earlier.id), /CHECK/, 'never itself');
  db.prepare('UPDATE pending_cancellations SET superseded_by_id = ? WHERE id = ?').run(later.id, earlier.id);
  const linked = rows(db)[0];
  assert.deepEqual({ ...linked, superseded_by_id: null }, earlier, 'only the link is set; the earlier record is kept as it was');
  assert.equal(rows(db).length, 3);
  db.prepare('DELETE FROM pending_cancellations WHERE id = ?').run(later.id);
  assert.deepEqual(rows(db)[0], earlier, 'link cleared, earlier record unchanged and still there');
  // lost_value_basis accepts only blank, Whole sale or Part of the work.
  assert.throws(() => db.prepare("UPDATE pending_cancellations SET lost_value_basis = 'everything' WHERE id = ?").run(earlier.id), /CHECK/);
});

test('fresh install and the running app: same columns as the migration; Pending Cancellations created as before keep the new fields blank', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const cols = dbAll('PRAGMA table_info(pending_cancellations)').map((c) => c.name);
    for (const n of NEW) assert.ok(cols.includes(n), n);
    const b = (await server.request('GET', '/settings/bundle')).data;
    const res = await server.request('POST', '/calls', {
      callAt: '2026-05-05T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'PC-1',
      cancellationReasonId: b.lists.pending_cancellation_reason?.[0]?.id,
    });
    assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.data));
    const [pc] = dbAll('SELECT * FROM pending_cancellations');
    assert.equal(pc.job_number, 'PC-1');
    for (const n of NEW) assert.ok(pc[n] === '' || pc[n] === null, `${n} untouched by the existing flow`);
  } finally {
    server.close();
  }
});

test('backups: a new backup includes the fields; an older backup (without them) restores with them blank', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const b = (await server.request('GET', '/settings/bundle')).data;
    await server.request('POST', '/calls', {
      callAt: '2026-05-05T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'PC-2',
      cancellationReasonId: b.lists.pending_cancellation_reason?.[0]?.id,
    });
    await server.request('POST', '/calls', {
      callAt: '2026-05-06T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'PC-2',
      cancellationReasonId: b.lists.pending_cancellation_reason?.[0]?.id,
    });
    // Test values (direct, as nothing writes these yet): the first is
    // superseded by the second, which points FORWARD to a later id.
    const { run } = await import('../src/db/index.js');
    const [first, second] = dbAll('SELECT id FROM pending_cancellations ORDER BY id');
    run("UPDATE pending_cancellations SET invoice_number = '2181', lost_value_ex_gst = 1000.5, lost_value_basis = 'part_of_work', superseded_by_id = ? WHERE id = ?", [second.id, first.id]);
    run("UPDATE pending_cancellations SET invoice_number = '2181', lost_value_ex_gst = 4754, lost_value_basis = 'whole_sale' WHERE id = ?", [second.id]);
    const backup = (await server.request('GET', '/export/backup.json')).data;
    const saved = backup.tables.pending_cancellations[0];
    assert.deepEqual([saved.invoice_number, saved.lost_value_ex_gst, saved.lost_value_basis], ['2181', 1000.5, 'part_of_work']);

    const res = await server.request('POST', '/export/restore', backup);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(
      dbAll('SELECT lost_value_ex_gst AS v, superseded_by_id AS s FROM pending_cancellations ORDER BY id').map((r) => [r.v, r.s]),
      [[1000.5, second.id], [4754, null]],
      'values and the superseded link restored'
    );

    const old = JSON.parse(JSON.stringify(backup));
    old.tables.pending_cancellations.forEach((r) => NEW.forEach((n) => delete r[n]));
    const res2 = await server.request('POST', '/export/restore', old);
    assert.equal(res2.status, 200, JSON.stringify(res2.data));
    const restored = dbAll('SELECT * FROM pending_cancellations ORDER BY id');
    assert.equal(restored.length, 2);
    for (const pc of restored) for (const n of NEW) assert.ok(pc[n] === '' || pc[n] === null, `${n} blank after restoring an older backup`);
  } finally {
    server.close();
  }
});
