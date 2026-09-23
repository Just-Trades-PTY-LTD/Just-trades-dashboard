import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, getHistory, getHistoryCounts } from '../lib/audit.js';
import { mergeId } from '../lib/merge.js';
import { findLatestSale, findOriginalJob } from '../services/lookup.js';
import { buildCallHistoryWorkbook } from '../lib/xlsxHistory.js';

const PENDING_CANCELLATION_TRACKED_FIELDS = ['job_number', 'credited_technician_id', 'trade_id', 'reason_id', 'comments'];

/**
 * A "Pending Cancellation" call links to the job's existing sale by JN — it
 * never creates a new job or sale. This keeps that link's pending_cancellations
 * row in sync with the call: created the first time a call becomes a Pending
 * Cancellation, updated in place on later edits, and removed if the call is
 * edited away from Pending Cancellation or deleted outright. Returns the
 * pending_cancellation_id the calls row should now store (or null).
 */
function syncPendingCancellation({ existingPendingCancellationId, callType, cancellationType, jobNumber, tradeId, cancellationReasonId, notes, callAt, userId }) {
  const shouldHaveLink = callType === 'Cancellation' && cancellationType === 'Pending Cancellation' && !!jobNumber;

  if (!shouldHaveLink) {
    if (existingPendingCancellationId) run('DELETE FROM pending_cancellations WHERE id = ?', [existingPendingCancellationId]);
    return null;
  }

  const sale = findLatestSale(jobNumber);
  const fields = {
    sale_id: sale?.id || null,
    job_number: jobNumber,
    date_logged: (callAt || '').slice(0, 10),
    credited_technician_id: sale?.credited_technician_id || null,
    trade_id: tradeId || sale?.trade_id || null,
    reason_id: cancellationReasonId || null,
    comments: notes || '',
  };

  if (existingPendingCancellationId) {
    const before = get('SELECT * FROM pending_cancellations WHERE id = ?', [existingPendingCancellationId]);
    run(
      `UPDATE pending_cancellations SET sale_id=?, job_number=?, date_logged=?, credited_technician_id=?, trade_id=?,
        reason_id=?, comments=?, updated_at=datetime('now') WHERE id=?`,
      [fields.sale_id, fields.job_number, fields.date_logged, fields.credited_technician_id, fields.trade_id, fields.reason_id, fields.comments, existingPendingCancellationId]
    );
    if (before) {
      recordAudit({
        entityType: 'pending_cancellation',
        entityId: existingPendingCancellationId,
        before,
        after: fields,
        fields: PENDING_CANCELLATION_TRACKED_FIELDS,
        userId,
      });
    }
    return existingPendingCancellationId;
  }

  const { lastInsertRowid } = run(
    `INSERT INTO pending_cancellations (sale_id, job_number, date_logged, credited_technician_id, trade_id, reason_id, comments, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.sale_id, fields.job_number, fields.date_logged, fields.credited_technician_id, fields.trade_id, fields.reason_id, fields.comments, userId]
  );
  recordAudit({
    entityType: 'pending_cancellation',
    entityId: lastInsertRowid,
    before: null,
    after: fields,
    fields: PENDING_CANCELLATION_TRACKED_FIELDS,
    userId,
  });
  return lastInsertRowid;
}

const TRACKED_FIELDS = [
  'direction',
  'handled_by_user_id',
  'call_type',
  'trade_id',
  'job_type_id',
  'lead_source_id',
  'booked',
  'not_booked_reason_id',
  'cancellation_type',
  'cancellation_reason_id',
  'call_back_reason_id',
  'job_number',
  'suburb',
  'notes',
];

function toRow(c) {
  return {
    id: c.id,
    archived: !!c.archived,
    callAt: c.call_at,
    direction: c.direction,
    handledByUserId: c.handled_by_user_id,
    handledByName: c.handled_by_name,
    callType: c.call_type,
    tradeId: c.trade_id,
    tradeName: c.trade_name,
    jobTypeId: c.job_type_id,
    jobTypeName: c.job_type_name,
    leadSourceId: c.lead_source_id,
    leadSourceName: c.lead_source_name,
    booked: c.booked,
    notBookedReasonId: c.not_booked_reason_id,
    notBookedReasonName: c.not_booked_reason_name,
    cancellationType: c.cancellation_type,
    cancellationReasonId: c.cancellation_reason_id,
    cancellationReasonName: c.cancellation_reason_name,
    callBackReasonId: c.call_back_reason_id,
    callBackReasonName: c.call_back_reason_name,
    jobNumber: c.job_number,
    suburb: c.suburb,
    notes: c.notes,
    followUp: !!c.follow_up,
    createdByName: c.created_by_name,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    historyCount: c.historyCount || 0,
  };
}

const SELECT_SQL = `
  SELECT c.*, u.name AS handled_by_name, cu.name AS created_by_name,
    tr.name AS trade_name, jt.name AS job_type_name, ls.name AS lead_source_name,
    nbr.name AS not_booked_reason_name, cr.name AS cancellation_reason_name, cbr.name AS call_back_reason_name
  FROM calls c
  LEFT JOIN users u ON u.id = c.handled_by_user_id
  LEFT JOIN users cu ON cu.id = c.created_by_user_id
  LEFT JOIN trades tr ON tr.id = c.trade_id
  LEFT JOIN job_types jt ON jt.id = c.job_type_id
  LEFT JOIN list_items ls ON ls.id = c.lead_source_id
  LEFT JOIN list_items nbr ON nbr.id = c.not_booked_reason_id
  LEFT JOIN list_items cr ON cr.id = c.cancellation_reason_id
  LEFT JOIN list_items cbr ON cbr.id = c.call_back_reason_id
`;

export function listCalls({ from, to, handledByUserId, callType, jobNumber, includeArchived } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived || includeArchived === 'false') where.push('c.archived = 0');
  if (from) {
    where.push('c.call_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('c.call_at <= ?');
    params.push(`${to}T23:59`);
  }
  if (handledByUserId) {
    where.push('c.handled_by_user_id = ?');
    params.push(handledByUserId);
  }
  if (callType) {
    where.push('c.call_type = ?');
    params.push(callType);
  }
  if (jobNumber) {
    where.push('lower(trim(c.job_number)) = ?');
    params.push(String(jobNumber).trim().toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(`${SELECT_SQL} ${whereSql} ORDER BY c.call_at DESC`, params);
  const counts = getHistoryCounts('call', rows.map((r) => r.id));
  return rows.map((r) => {
    const row = toRow(r);
    row.historyCount = counts[r.id] || 0;
    row.linkedJob = r.job_number ? !!findOriginalJob(r.job_number) : false;
    return row;
  });
}

export function createCallsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json(listCalls(req.query));
  });

  router.get('/export.xlsx', async (req, res) => {
    const rows = listCalls(req.query);
    const staffLookup = new Map(all('SELECT id, name FROM users').map((u) => [String(u.id), u.name]));
    const wb = buildCallHistoryWorkbook(rows, req.query, staffLookup);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="call-history-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  router.get('/:id/history', (req, res) => {
    res.json(getHistory('call', req.params.id));
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    const lastInsertRowid = transaction(() => {
      const pendingCancellationId = syncPendingCancellation({
        existingPendingCancellationId: null,
        callType: b.callType || 'Lead',
        cancellationType: b.cancellationType || '',
        jobNumber: b.jobNumber || '',
        tradeId: b.tradeId || null,
        cancellationReasonId: b.cancellationReasonId || null,
        notes: b.notes || '',
        callAt: b.callAt,
        userId: req.user.id,
      });
      const values = {
        call_at: b.callAt,
        direction: b.direction || 'Inbound',
        handled_by_user_id: b.handledByUserId || null,
        call_type: b.callType || 'Lead',
        trade_id: b.tradeId || null,
        job_type_id: b.jobTypeId || null,
        lead_source_id: b.leadSourceId || null,
        booked: b.booked || '',
        not_booked_reason_id: b.notBookedReasonId || null,
        cancellation_type: b.cancellationType || '',
        cancellation_reason_id: b.cancellationReasonId || null,
        call_back_reason_id: b.callBackReasonId || null,
        job_number: b.jobNumber || '',
        suburb: b.suburb || '',
        notes: b.notes || '',
      };
      const { lastInsertRowid: id } = run(
        `INSERT INTO calls (call_at, direction, handled_by_user_id, call_type, trade_id, job_type_id, lead_source_id,
          booked, not_booked_reason_id, cancellation_type, cancellation_reason_id, call_back_reason_id, job_number,
          pending_cancellation_id, suburb, notes, follow_up, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          values.call_at,
          values.direction,
          values.handled_by_user_id,
          values.call_type,
          values.trade_id,
          values.job_type_id,
          values.lead_source_id,
          values.booked,
          values.not_booked_reason_id,
          values.cancellation_type,
          values.cancellation_reason_id,
          values.call_back_reason_id,
          values.job_number,
          pendingCancellationId,
          values.suburb,
          values.notes,
          b.followUp ? 1 : 0,
          req.user.id,
        ]
      );
      recordAudit({ entityType: 'call', entityId: id, before: null, after: values, fields: TRACKED_FIELDS, userId: req.user.id });
      return id;
    });
    res.status(201).json(toRow(get(`${SELECT_SQL} WHERE c.id = ?`, [lastInsertRowid])));
  });

  router.patch('/:id', (req, res) => {
    const existing = get('SELECT * FROM calls WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {};
    const next = {
      call_at: b.callAt ?? existing.call_at,
      direction: b.direction ?? existing.direction,
      handled_by_user_id: mergeId(b.handledByUserId, existing.handled_by_user_id),
      call_type: b.callType ?? existing.call_type,
      trade_id: mergeId(b.tradeId, existing.trade_id),
      job_type_id: mergeId(b.jobTypeId, existing.job_type_id),
      lead_source_id: mergeId(b.leadSourceId, existing.lead_source_id),
      booked: b.booked ?? existing.booked,
      not_booked_reason_id: mergeId(b.notBookedReasonId, existing.not_booked_reason_id),
      cancellation_type: b.cancellationType ?? existing.cancellation_type,
      cancellation_reason_id: mergeId(b.cancellationReasonId, existing.cancellation_reason_id),
      call_back_reason_id: mergeId(b.callBackReasonId, existing.call_back_reason_id),
      job_number: b.jobNumber ?? existing.job_number,
      suburb: b.suburb ?? existing.suburb,
      notes: b.notes ?? existing.notes,
      follow_up: b.followUp !== undefined ? (b.followUp ? 1 : 0) : existing.follow_up,
    };
    transaction(() => {
      const pendingCancellationId = syncPendingCancellation({
        existingPendingCancellationId: existing.pending_cancellation_id,
        callType: next.call_type,
        cancellationType: next.cancellation_type,
        jobNumber: next.job_number,
        tradeId: next.trade_id,
        cancellationReasonId: next.cancellation_reason_id,
        notes: next.notes,
        callAt: next.call_at,
        userId: req.user.id,
      });
      run(
        `UPDATE calls SET call_at=?, direction=?, handled_by_user_id=?, call_type=?, trade_id=?, job_type_id=?,
          lead_source_id=?, booked=?, not_booked_reason_id=?, cancellation_type=?, cancellation_reason_id=?,
          call_back_reason_id=?, job_number=?, pending_cancellation_id=?, suburb=?, notes=?, follow_up=?,
          updated_at=datetime('now') WHERE id=?`,
        [
          next.call_at,
          next.direction,
          next.handled_by_user_id,
          next.call_type,
          next.trade_id,
          next.job_type_id,
          next.lead_source_id,
          next.booked,
          next.not_booked_reason_id,
          next.cancellation_type,
          next.cancellation_reason_id,
          next.call_back_reason_id,
          next.job_number,
          pendingCancellationId,
          next.suburb,
          next.notes,
          next.follow_up,
          req.params.id,
        ]
      );
    });
    recordAudit({
      entityType: 'call',
      entityId: Number(req.params.id),
      before: existing,
      after: next,
      fields: TRACKED_FIELDS,
      userId: req.user.id,
    });
    res.json(toRow(get(`${SELECT_SQL} WHERE c.id = ?`, [req.params.id])));
  });

  router.patch('/:id/archive', (req, res) => {
    const archived = req.body?.archived ? 1 : 0;
    transaction(() => {
      const call = get('SELECT pending_cancellation_id FROM calls WHERE id = ?', [req.params.id]);
      run('UPDATE calls SET archived = ? WHERE id = ?', [archived, req.params.id]);
      if (call?.pending_cancellation_id) {
        run('UPDATE pending_cancellations SET archived = ? WHERE id = ?', [archived, call.pending_cancellation_id]);
      }
    });
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    transaction(() => {
      const call = get('SELECT pending_cancellation_id FROM calls WHERE id = ?', [req.params.id]);
      run('DELETE FROM calls WHERE id = ?', [req.params.id]);
      if (call?.pending_cancellation_id) run('DELETE FROM pending_cancellations WHERE id = ?', [call.pending_cancellation_id]);
    });
    res.json({ ok: true });
  });

  return router;
}
