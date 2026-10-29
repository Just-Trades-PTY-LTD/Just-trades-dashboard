import { Router } from 'express';
import { run, transaction } from '../db/index.js';
import { buildBackupPayload, listAutomaticBackups, readAutomaticBackup, writeAutomaticBackup } from '../db/backup.js';
import { restoreFromBackup, RestoreError } from '../db/restore.js';
import path from 'node:path';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { toCSV } from '../lib/csv.js';
import { config } from '../config.js';
import { CALL_COLUMNS, TECH_COLUMNS } from '../lib/historyColumns.js';

// dbPath: the database this server actually opened (equal to config.dbPath
// in production), where automatic backups live alongside it.
export function createExportRouter({ getCallRows, getTechEntryRows, dbPath = config.dbPath }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/calls.csv', requireAdmin, (req, res) => {
    const rows = getCallRows({ includeArchived: 'true' }).map((r) => ({ ...r, archived: r.archived ? 'Yes' : 'No' }));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="calls-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCSV(CALL_COLUMNS, rows));
  });

  router.get('/tech-entries.csv', requireAdmin, (req, res) => {
    const rows = getTechEntryRows({ includeArchived: 'true' }).map((r) => ({
      ...r,
      archived: r.archived ? 'Yes' : 'No',
      convertedLater: r.convertedLater ? 'Yes' : 'No',
      knockback: r.knockback ? 'Yes' : 'No',
    }));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="technician-sales-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCSV(TECH_COLUMNS, rows));
  });

  router.get('/backup.json', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="crm-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(buildBackupPayload(), null, 2));
  });

  // Automatic, server-generated snapshots (see db/backup.js) — a safety net
  // for application-level mistakes, on top of whatever the Export full
  // backup button above has been used to save elsewhere.
  router.get('/auto-backups', requireAdmin, (req, res) => {
    res.json(listAutomaticBackups(dbPath));
  });

  router.get('/auto-backups/:filename', requireAdmin, (req, res) => {
    const content = readAutomaticBackup(dbPath, req.params.filename);
    if (!content) return res.status(404).json({ error: 'Backup not found.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.send(content);
  });

  router.post('/restore', requireAdmin, (req, res) => {
    // A snapshot of the current data first, so any restore can be undone
    // from the automatic backups list. No snapshot, no restore.
    let safetySnapshot;
    try {
      safetySnapshot = path.basename(writeAutomaticBackup(dbPath));
    } catch (err) {
      return res.status(500).json({ error: `Restore cancelled — a safety snapshot of the current data couldn't be saved first (${err.message}). Nothing was changed.` });
    }
    try {
      const result = restoreFromBackup(req.body);
      res.json({ ok: true, safetySnapshot, ...result });
    } catch (err) {
      const message = err instanceof RestoreError ? err.message : `Restore failed: ${err.message}. Nothing was changed.`;
      res.status(400).json({ error: message, safetySnapshot });
    }
  });

  router.post('/clear-calls', requireAdmin, (req, res) => {
    run('DELETE FROM calls');
    res.json({ ok: true });
  });

  router.post('/clear-tech-data', requireAdmin, (req, res) => {
    transaction(() => {
      run('DELETE FROM pending_cancellations');
      run('DELETE FROM call_backs');
      run('DELETE FROM sales');
      run('DELETE FROM jobs');
    });
    res.json({ ok: true });
  });

  return router;
}
