import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestServer } from './helpers.js';
import { openDb, run as dbRun, all as dbAll } from '../src/db/index.js';

// The 8 newer Knockback reasons are added once only. Before this fix the
// migration ran on every boot and re-added any that staff had removed in
// Settings (it happened in the live CRM on 15–17 Nov).

const NEW_REASONS = [
  'Customer getting other quotes',
  'Customer not ready to proceed',
  'Customer declined',
  'Unable to contact/customer unavailable',
  'Finance/payment issue',
  'Work not required',
  'Competitor selected',
  'Unknown/not provided',
];
const reasons = () => dbAll("SELECT name FROM list_items WHERE category = 'knockback_reason' ORDER BY id").map((r) => r.name);

test('a removed Knockback reason stays removed after restarts', async () => {
  const server = await startTestServer();
  const { dbPath } = server;
  server.close();
  try {
    openDb(dbPath);
    const before = reasons();
    for (const n of NEW_REASONS) assert.ok(before.includes(n), `fresh install has "${n}"`);
    // Staff remove three of them (the live situation), and the CRM restarts
    // as if this were the first boot of the new code.
    dbRun("DELETE FROM list_items WHERE category = 'knockback_reason' AND name IN ('Customer getting other quotes', 'Customer declined', 'Competitor selected')");
    dbRun("DELETE FROM one_time_migrations WHERE id = 'add_knockback_reason_options'");
    const removed = reasons();
    openDb(dbPath);
    assert.deepEqual(reasons(), removed, 'first boot of the new code adds nothing back');
    openDb(dbPath);
    assert.deepEqual(reasons(), removed, 'nor any later boot');
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('a database that only ever had the original reasons gets the 8 newer ones, once', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-')), 'reasons.sqlite');
  try {
    openDb(dbPath, { allowFreshInit: true });
    dbRun("DELETE FROM list_items WHERE category = 'knockback_reason'");
    dbRun("INSERT INTO list_items (category, name, sort_order) VALUES ('knockback_reason', 'Price', 0), ('knockback_reason', 'Timing', 1)");
    dbRun("DELETE FROM one_time_migrations WHERE id = 'add_knockback_reason_options'");
    openDb(dbPath);
    assert.deepEqual(reasons(), ['Price', 'Timing', ...NEW_REASONS]);
    openDb(dbPath);
    assert.equal(reasons().length, 10, 'never added twice');
  } finally {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
