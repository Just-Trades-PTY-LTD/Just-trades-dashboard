import { Router } from 'express';
import { prepare, run, transaction } from '../db/index.js';
import { BACKUP_TABLES, buildBackupPayload, listAutomaticBackups, readAutomaticBackup } from '../db/backup.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { toCSV } from '../lib/csv.js';
import { config } from '../config.js';

const CALL_COLUMNS = [
  { key: 'archived', label: 'Archived' },
  { key: 'callAt', label: 'Date/time' },
  { key: 'direction', label: 'Direction' },
  { key: 'handledByName', label: 'Handled by' },
  { key: 'callType', label: 'Call type' },
  { key: 'tradeName', label: 'Trade' },
  { key: 'jobTypeName', label: 'Job type' },
  { key: 'leadSourceName', label: 'Lead source' },
  { key: 'booked', label: 'Booked' },
  { key: 'notBookedReasonName', label: 'Not booked reason' },
  { key: 'cancellationType', label: 'Cancellation type' },
  { key: 'cancellationReasonName', label: 'Cancellation reason' },
  { key: 'callBackReasonName', label: 'Call back reason' },
  { key: 'jobNumber', label: 'Job number' },
  { key: 'suburb', label: 'Suburb' },
  { key: 'notes', label: 'Notes' },
];

const TECH_COLUMNS = [
  { key: 'archived', label: 'Archived' },
  { key: 'entryLabel', label: 'Entry type' },
  { key: 'dateShown', label: 'Date' },
  { key: 'technicianName', label: 'Technician' },
  { key: 'creditedTechnicianName', label: 'Credited technician' },
  { key: 'jobNumber', label: 'Job number' },
  { key: 'tradeName', label: 'Trade' },
  { key: 'jobTypeName', label: 'Job type' },
  { key: 'lead', label: 'Lead' },
  { key: 'inspectionSheet', label: 'Inspection sheet' },
  { key: 'optionSheet', label: 'Option sheet' },
  { key: 'knockback', label: 'Knock back' },
  { key: 'knockbackReasonName', label: 'Knock back reason' },
  { key: 'convertedLater', label: 'Converted later' },
  { key: 'invoiceNumber', label: 'Invoice number' },
  { key: 'invoiceDate', label: 'Invoice date' },
  { key: 'saleValueExGst', label: 'Sale value (ex GST)' },
  { key: 'reasonName', label: 'Call back / cancellation reason' },
  { key: 'comments', label: 'Comments' },
];

export function createExportRouter({ getCallRows, getTechEntryRows }) {
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
    res.json(listAutomaticBackups(config.dbPath));
  });

  router.get('/auto-backups/:filename', requireAdmin, (req, res) => {
    const content = readAutomaticBackup(config.dbPath, req.params.filename);
    if (!content) return res.status(404).json({ error: 'Backup not found.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.send(content);
  });

  router.post('/restore', requireAdmin, (req, res) => {
    const { tables } = req.body || {};
    if (!tables || typeof tables !== 'object') return res.status(400).json({ error: 'That file could not be read as a CRM backup.' });
    try {
      transaction(() => {
        // Delete in reverse dependency order, then reinsert in forward order.
        [...BACKUP_TABLES].reverse().forEach((t) => run(`DELETE FROM ${t}`));
        BACKUP_TABLES.forEach((t) => {
          const rows = Array.isArray(tables[t]) ? tables[t] : [];
          if (!rows.length) return;
          const columns = Object.keys(rows[0]);
          const placeholders = columns.map(() => '?').join(',');
          const insert = prepare(`INSERT INTO ${t} (${columns.join(',')}) VALUES (${placeholders})`);
          rows.forEach((row) => insert.run(...columns.map((c) => row[c])));
        });
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: `Restore failed: ${err.message}` });
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
