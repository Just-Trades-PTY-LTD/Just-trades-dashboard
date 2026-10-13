import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { addDays, adelaideDateStamp, shiftWeekendToMonday, utcToAdelaideDisplay } from '../lib/adelaideTime.js';
import { findActiveFollowUpForJob } from '../services/lookup.js';

// Quote Follow-up trial — a purely operational reminder to call a customer
// back about a quote after a knock-back. Deliberately NOT another Job or
// Sale: nothing here is ever read by services/reports.js, so it can never
// affect Total/Qualified Jobs, Sales, Knock-backs, Conversion, or any
// technician figure. See db/schema.sql's follow_ups/follow_up_events tables
// for the full reasoning.

const CLOSE_OUTCOMES = ['quote_approved', 'quote_rejected', 'unable_to_contact', 'no_longer_required', 'other'];
const DEFAULT_DUE_DAYS = 10;

export function getFollowUpDefaultDueDays() {
  const row = get("SELECT value FROM app_settings WHERE key = 'follow_up_default_due_days'");
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DUE_DAYS;
}

// The default due date for a brand-new follow-up: attendance date + the
// configured number of days, shifted to the following Monday if that lands
// on a Saturday/Sunday (nobody is rostered to call customers back on a
// weekend). Exported so the client can show the same computed default
// in the "Follow-up required" checkbox's date field before saving.
export function computeDefaultDueDate(attendanceDate, days = getFollowUpDefaultDueDays()) {
  return shiftWeekendToMonday(addDays(attendanceDate, days));
}

function followUpRow(id) {
  return get(
    `SELECT f.*, t.name AS technician_name, tr.name AS trade_name, jt.name AS job_type_name, cu.name AS created_by_name
     FROM follow_ups f
     LEFT JOIN technicians t ON t.id = f.technician_id
     LEFT JOIN trades tr ON tr.id = f.trade_id
     LEFT JOIN job_types jt ON jt.id = f.job_type_id
     LEFT JOIN users cu ON cu.id = f.created_by_user_id
     WHERE f.id = ?`,
    [id]
  );
}

function toEntry(f) {
  return {
    id: f.id,
    jobId: f.job_id,
    jobNumber: f.job_number,
    status: f.status,
    closedOutcome: f.closed_outcome || '',
    dueDate: f.due_date,
    technicianId: f.technician_id,
    technicianName: f.technician_name || '',
    tradeId: f.trade_id,
    tradeName: f.trade_name || '',
    jobTypeId: f.job_type_id,
    jobTypeName: f.job_type_name || '',
    suburb: f.suburb || '',
    originalAttendanceDate: f.original_attendance_date,
    createdByName: f.created_by_name || '',
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

function eventToEntry(e) {
  return {
    id: e.id,
    kind: e.kind,
    note: e.note || '',
    previousDueDate: e.previous_due_date || '',
    newDueDate: e.new_due_date || '',
    byName: e.changed_by_name || 'Unknown',
    // Stamped via datetime('now') (genuinely UTC), so — unlike this app's own
    // audit_log history, which intentionally shows its raw UTC timestamp —
    // this is converted for display: the user explicitly asked for notes to
    // retain "staff member and Adelaide date/time".
    at: utcToAdelaideDisplay(e.created_at),
  };
}

function getEvents(followUpId) {
  const rows = all(
    `SELECT e.*, u.name AS changed_by_name
     FROM follow_up_events e
     LEFT JOIN users u ON u.id = e.created_by_user_id
     WHERE e.follow_up_id = ?
     ORDER BY e.created_at ASC, e.id ASC`,
    [followUpId]
  );
  return rows.map(eventToEntry);
}

// Overdue (oldest first) > Due Today > Upcoming (soonest first) — the exact
// priority order requested for the active list. Status is never stored as
// anything but 'active'/'closed'; which of these three buckets a task falls
// into is always computed fresh against "today in Adelaide", so a task can
// never get stuck in a stale bucket and nothing here ever needs a scheduled
// job to "promote" it.
function bucketOf(dueDate, today) {
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'due_today';
  return 'upcoming';
}

export function createFollowUpsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    const status = req.query.status === 'closed' ? 'closed' : 'active';
    if (status === 'active') {
      const rows = all(
        `SELECT f.*, t.name AS technician_name, tr.name AS trade_name, jt.name AS job_type_name, cu.name AS created_by_name
         FROM follow_ups f
         LEFT JOIN technicians t ON t.id = f.technician_id
         LEFT JOIN trades tr ON tr.id = f.trade_id
         LEFT JOIN job_types jt ON jt.id = f.job_type_id
         LEFT JOIN users cu ON cu.id = f.created_by_user_id
         WHERE f.status = 'active'
         ORDER BY f.due_date ASC, f.id ASC`
      );
      const today = adelaideDateStamp();
      const entries = rows.map((r) => ({ ...toEntry(r), bucket: bucketOf(r.due_date, today) }));
      const overdueCount = entries.filter((e) => e.bucket === 'overdue').length;
      return res.json({ entries, overdueCount, today });
    }

    // Closed, kept searchable — a simple keyword match on Job Number/Suburb,
    // same convention as every other "keyword search" field in this app.
    const q = (req.query.q || '').trim().toLowerCase();
    let rows = all(
      `SELECT f.*, t.name AS technician_name, tr.name AS trade_name, jt.name AS job_type_name, cu.name AS created_by_name
       FROM follow_ups f
       LEFT JOIN technicians t ON t.id = f.technician_id
       LEFT JOIN trades tr ON tr.id = f.trade_id
       LEFT JOIN job_types jt ON jt.id = f.job_type_id
       LEFT JOIN users cu ON cu.id = f.created_by_user_id
       WHERE f.status = 'closed'
       ORDER BY f.updated_at DESC, f.id DESC`
    );
    if (q) {
      rows = rows.filter((r) => `${r.job_number} ${r.suburb}`.toLowerCase().includes(q));
    }
    res.json({ entries: rows.map(toEntry) });
  });

  router.get('/default-due-date', (req, res) => {
    const attendanceDate = req.query.attendanceDate;
    if (!attendanceDate) return res.status(400).json({ error: 'attendanceDate is required.' });
    res.json({ dueDate: computeDefaultDueDate(attendanceDate), defaultDueDays: getFollowUpDefaultDueDays() });
  });

  router.get('/:id', (req, res) => {
    const f = followUpRow(req.params.id);
    if (!f) return res.status(404).json({ error: 'Follow-up not found.' });
    res.json({ ...toEntry(f), events: getEvents(f.id) });
  });

  // Created either straight from the "Follow-up required" checkbox on a
  // brand-new knock-back, or via "Add follow-up" on an existing one in Job
  // History — both send the same body. jobId must be a genuine, currently
  // active knock-back job (knockback = 1); at most one active follow-up is
  // ever allowed per job, so a second attempt is rejected with the existing
  // task's id rather than creating a duplicate.
  router.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.jobId) return res.status(400).json({ error: 'jobId is required.' });
    if (!b.dueDate) return res.status(400).json({ error: 'Please choose a due date before saving.' });
    const job = get('SELECT * FROM jobs WHERE id = ? AND archived = 0', [b.jobId]);
    if (!job) return res.status(400).json({ error: 'That job could not be found.' });
    if (!job.knockback) {
      return res.status(400).json({ error: 'A follow-up can only be created for a job that was knocked back.' });
    }
    const existing = findActiveFollowUpForJob(job.id);
    if (existing) {
      return res.status(400).json({
        error: `An active follow-up already exists for Job Number ${job.job_number}.`,
        existingFollowUpId: existing.id,
      });
    }

    const followUpId = transaction(() => {
      const { lastInsertRowid } = run(
        `INSERT INTO follow_ups (job_id, job_number, due_date, technician_id, trade_id, job_type_id, suburb,
           original_attendance_date, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [job.id, job.job_number, b.dueDate, job.technician_id, job.trade_id, job.job_type_id, job.suburb || '', job.visit_date, req.user.id]
      );
      run(
        `INSERT INTO follow_up_events (follow_up_id, kind, new_due_date, created_by_user_id) VALUES (?, 'created', ?, ?)`,
        [lastInsertRowid, b.dueDate, req.user.id]
      );
      return lastInsertRowid;
    });

    res.status(201).json({ ...toEntry(followUpRow(followUpId)), events: getEvents(followUpId) });
  });

  router.post('/:id/notes', (req, res) => {
    const f = get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Follow-up not found.' });
    const note = (req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Please enter a note before saving.' });
    run(`INSERT INTO follow_up_events (follow_up_id, kind, note, created_by_user_id) VALUES (?, 'note', ?, ?)`, [f.id, note, req.user.id]);
    run("UPDATE follow_ups SET updated_at = datetime('now') WHERE id = ?", [f.id]);
    res.json({ ...toEntry(followUpRow(f.id)), events: getEvents(f.id) });
  });

  // Reschedules the SAME task — never creates a new one. `note` is optional
  // here (e.g. "Due date moved — not contacted, busy day" vs. a genuine
  // "Follow up again" after an actual contact attempt), so both of the
  // reschedule flows you described share this one endpoint; the distinction
  // lives in the note's own text, not in two separate code paths.
  router.patch('/:id/due-date', (req, res) => {
    const f = get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Follow-up not found.' });
    const newDueDate = req.body?.dueDate;
    if (!newDueDate) return res.status(400).json({ error: 'Please choose a new due date.' });
    const note = (req.body?.note || '').trim();
    transaction(() => {
      run("UPDATE follow_ups SET due_date = ?, updated_at = datetime('now') WHERE id = ?", [newDueDate, f.id]);
      run(
        `INSERT INTO follow_up_events (follow_up_id, kind, note, previous_due_date, new_due_date, created_by_user_id)
         VALUES (?, 'reschedule', ?, ?, ?, ?)`,
        [f.id, note, f.due_date, newDueDate, req.user.id]
      );
    });
    res.json({ ...toEntry(followUpRow(f.id)), events: getEvents(f.id) });
  });

  router.patch('/:id/close', (req, res) => {
    const f = get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Follow-up not found.' });
    const outcome = req.body?.outcome;
    if (!CLOSE_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: 'Please choose a valid outcome before closing.' });
    }
    const note = (req.body?.note || '').trim();
    transaction(() => {
      run("UPDATE follow_ups SET status = 'closed', closed_outcome = ?, updated_at = datetime('now') WHERE id = ?", [outcome, f.id]);
      run(`INSERT INTO follow_up_events (follow_up_id, kind, note, created_by_user_id) VALUES (?, 'closed', ?, ?)`, [f.id, note, req.user.id]);
    });
    res.json({ ...toEntry(followUpRow(f.id)), events: getEvents(f.id) });
  });

  router.patch('/:id/reopen', (req, res) => {
    const f = get('SELECT * FROM follow_ups WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Follow-up not found.' });
    if (f.status !== 'closed') return res.status(400).json({ error: 'Only a closed follow-up can be reopened.' });
    const note = (req.body?.note || '').trim();
    transaction(() => {
      run(
        "UPDATE follow_ups SET status = 'active', closed_outcome = '', closed_by_sale_id = NULL, updated_at = datetime('now') WHERE id = ?",
        [f.id]
      );
      run(`INSERT INTO follow_up_events (follow_up_id, kind, note, created_by_user_id) VALUES (?, 'reopened', ?, ?)`, [f.id, note, req.user.id]);
    });
    res.json({ ...toEntry(followUpRow(f.id)), events: getEvents(f.id) });
  });

  return router;
}
