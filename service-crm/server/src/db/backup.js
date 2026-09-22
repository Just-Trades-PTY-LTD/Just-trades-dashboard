import fs from 'node:fs';
import path from 'node:path';
import { all } from './index.js';

// Every table a full backup/restore needs to round-trip. Shared by the
// admin-triggered export/restore routes and the automatic snapshot job below
// so the two can never drift out of sync with each other.
export const BACKUP_TABLES = [
  'trades',
  'job_types',
  'technicians',
  'list_items',
  'suburbs',
  'calls',
  'jobs',
  'sales',
  'call_backs',
  'pending_cancellations',
  'audit_log',
];

export function buildBackupPayload() {
  const backup = { exportedAt: new Date().toISOString(), tables: {} };
  BACKUP_TABLES.forEach((t) => {
    backup.tables[t] = all(`SELECT * FROM ${t}`);
  });
  return backup;
}

const MAX_AUTOMATIC_BACKUPS = 30;
const FILENAME_RE = /^backup-[A-Za-z0-9-]+\.json$/;

function backupsDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

function listBackupFilenames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILENAME_RE.test(f))
    .sort();
}

/** Writes a timestamped snapshot next to the live database (same volume, so
 * this guards against application-level mistakes — a bad edit, an accidental
 * clear/restore — not against the volume itself disappearing). Keeps only the
 * most recent MAX_AUTOMATIC_BACKUPS, oldest first out. */
export function writeAutomaticBackup(dbPath) {
  const dir = backupsDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(buildBackupPayload(), null, 2));

  const files = listBackupFilenames(dir);
  const excess = files.length - MAX_AUTOMATIC_BACKUPS;
  for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(dir, files[i]));

  return file;
}

export function listAutomaticBackups(dbPath) {
  const dir = backupsDir(dbPath);
  return listBackupFilenames(dir)
    .reverse()
    .map((filename) => {
      const stat = fs.statSync(path.join(dir, filename));
      return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    });
}

/** Returns the raw JSON text for one automatic backup, or null if the name
 * doesn't match an existing snapshot — the filename pattern check also rules
 * out path traversal via a crafted filename. */
export function readAutomaticBackup(dbPath, filename) {
  if (!FILENAME_RE.test(filename)) return null;
  const file = path.join(backupsDir(dbPath), filename);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}
