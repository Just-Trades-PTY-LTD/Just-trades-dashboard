import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { writeAutomaticBackup, listAutomaticBackups, readAutomaticBackup, buildBackupPayload } from '../src/db/backup.js';
import { openDb, waitForParentDirectory, DatabaseMissingError } from '../src/db/index.js';

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

test('openDb survives a volume that finishes mounting just after boot, instead of racing it', () => {
  // Simulates what was actually observed on Railway: the mount for the
  // parent directory lands a moment after the process starts, not before.
  // Use a real child process to create it mid-wait — our wait loop blocks
  // this thread synchronously, so nothing in-process could do it concurrently.
  const parentDir = path.join(os.tmpdir(), `crm-race-test-${Date.now()}`);
  assert.equal(fs.existsSync(parentDir), false);
  const child = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').mkdirSync(${JSON.stringify(parentDir)}), 300)`]);

  try {
    const appeared = waitForParentDirectory(parentDir);
    assert.equal(appeared, true, 'the directory should be picked up once the "mount" finishes, not raced past');
    assert.equal(fs.existsSync(parentDir), true);
  } finally {
    child.kill();
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});

test('openDb opens normally, without any wait, when the parent directory already exists', () => {
  const dbPath = tempDbPath(); // mkdtempSync already created the parent dir
  const start = Date.now();
  openDb(dbPath, { allowFreshInit: true });
  assert.ok(Date.now() - start < 1000, 'should not wait at all when the directory is already there');
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
