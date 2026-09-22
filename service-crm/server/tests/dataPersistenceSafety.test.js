import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { writeAutomaticBackup, listAutomaticBackups, readAutomaticBackup, buildBackupPayload } from '../src/db/backup.js';
import { openDb, DatabaseMissingError } from '../src/db/index.js';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-persist-test-')), 'test.sqlite');
}

test('openDb refuses to silently create a new database when none exists and it is not allowed', () => {
  const dbPath = tempDbPath();
  assert.equal(fs.existsSync(dbPath), false);
  assert.throws(() => openDb(dbPath, { allowFreshInit: false }), DatabaseMissingError);
  // And it must not have created anything either.
  assert.equal(fs.existsSync(dbPath), false);
});

test('openDb opens normally when a database file already exists, regardless of allowFreshInit', () => {
  const dbPath = tempDbPath();
  openDb(dbPath, { allowFreshInit: true }); // first boot: fine, explicitly allowed
  assert.equal(fs.existsSync(dbPath), true);
  // Simulate a later, ordinary restart that never sets allowFreshInit.
  assert.doesNotThrow(() => openDb(dbPath, { allowFreshInit: false }));
});

test('createApp serves a clear warning instead of the real app when the database is missing', async () => {
  const dbPath = tempDbPath();
  const app = createApp({ dbPath, allowFreshInit: false });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /Database not found/);
    // Nothing should have been created on disk.
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    server.close();
  }
});

test('createApp starts normally and serves the real API once a database file already exists', async () => {
  const dbPath = tempDbPath();
  createApp({ dbPath, allowFreshInit: true }).listen(0).close(); // bootstrap once
  const app = createApp({ dbPath, allowFreshInit: false }); // then boot again without the flag
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('automatic backups are written to disk, rotated, and can be read back', async () => {
  const dbPath = tempDbPath();
  openDb(dbPath, { allowFreshInit: true });

  const file = writeAutomaticBackup(dbPath);
  assert.equal(fs.existsSync(file), true);

  const listed = listAutomaticBackups(dbPath);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].filename, path.basename(file));

  const content = JSON.parse(readAutomaticBackup(dbPath, listed[0].filename));
  assert.deepEqual(Object.keys(content.tables).sort(), Object.keys(buildBackupPayload().tables).sort());

  // A crafted filename can't be used to read outside the backups folder.
  assert.equal(readAutomaticBackup(dbPath, '../../etc/passwd'), null);
  assert.equal(readAutomaticBackup(dbPath, 'not-a-real-backup.json'), null);
});
