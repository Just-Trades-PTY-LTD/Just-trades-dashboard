import crypto from 'node:crypto';
import { all, get, prepare, run, transaction } from './index.js';
import { BACKUP_TABLES, OPTIONAL_BACKUP_TABLES } from './backup.js';
import { hashPassword } from '../lib/password.js';

// Replaces this CRM's data with the contents of a full backup (see
// buildBackupPayload in backup.js). All or nothing: it runs in one
// transaction with foreign-key checks deferred to the end, so the order rows
// go back in doesn't matter (e.g. jobs.converted_by_sale_id points at sales,
// which point back at jobs), and anything that doesn't link up rolls the
// whole restore back with the current data untouched.
//
// - Every table in BACKUP_TABLES is cleared and refilled from the backup (a
//   table missing from an older backup is simply left empty, exactly as
//   before this change).
// - OPTIONAL_BACKUP_TABLES (app settings) are only replaced when the backup
//   actually has them, so restoring an older backup keeps current settings.
// - Staff accounts are never replaced or changed. A backup lists accounts
//   without passwords; any account it references that this CRM doesn't
//   have (e.g. restoring onto a fresh install) is added as INACTIVE with an
//   unusable random password, so its records stay linked and an admin can
//   reactivate it and set a password later.
// - Only columns that exist in this database are restored, so a backup from
//   an older version (missing a newer column) still restores; the column
//   just takes its default.

export class RestoreError extends Error {}

function columnsOf(table) {
  return new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
}

function addMissingUsers(backupUsers) {
  if (!Array.isArray(backupUsers)) return 0;
  let added = 0;
  const insert = prepare(
    'INSERT INTO users (id, name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  );
  backupUsers.forEach((u) => {
    const id = Number(u?.id);
    if (!Number.isInteger(id) || get('SELECT id FROM users WHERE id = ?', [id])) return;
    const email = String(u.email || '').trim().toLowerCase();
    // The email may now belong to a different account; keep it unique.
    const freeEmail = email && !get('SELECT id FROM users WHERE email = ?', [email]) ? email : `restored-${id}-${email || 'user'}`;
    insert.run(
      id,
      String(u.name || `Restored user ${id}`),
      freeEmail,
      hashPassword(crypto.randomBytes(24).toString('hex')),
      u.role === 'admin' ? 'admin' : 'staff',
      u.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
    added += 1;
  });
  return added;
}

function insertRows(table, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const known = columnsOf(table);
  let count = 0;
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const cols = Object.keys(row).filter((c) => known.has(c));
    if (!cols.length) return;
    prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    count += 1;
  });
  return count;
}

export function restoreFromBackup(payload) {
  const tables = payload?.tables;
  if (!tables || typeof tables !== 'object' || !BACKUP_TABLES.some((t) => Array.isArray(tables[t]))) {
    throw new RestoreError('That file could not be read as a CRM backup.');
  }

  return transaction(() => {
    run('PRAGMA defer_foreign_keys = ON');
    const usersAdded = addMissingUsers(tables.users);

    [...BACKUP_TABLES].reverse().forEach((t) => run(`DELETE FROM ${t}`));
    const restored = {};
    BACKUP_TABLES.forEach((t) => {
      restored[t] = insertRows(t, tables[t]);
    });
    OPTIONAL_BACKUP_TABLES.forEach((t) => {
      if (!Array.isArray(tables[t])) return;
      run(`DELETE FROM ${t}`);
      restored[t] = insertRows(t, tables[t]);
    });

    // Checked here (rather than only by COMMIT) so the error can say which
    // tables don't link up; either way nothing is kept.
    const broken = all('PRAGMA foreign_key_check');
    if (broken.length) {
      const where = [...new Set(broken.map((b) => `${b.table} → ${b.parent}`))].join(', ');
      throw new RestoreError(`This backup's records don't link up (${where}), so nothing was restored.`);
    }
    return { restored, usersAdded };
  });
}
