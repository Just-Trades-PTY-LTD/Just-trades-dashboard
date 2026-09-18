import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, getHistory, getHistoryCounts } from '../lib/audit.js';
import { findOriginalJob } from '../services/lookup.js';

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

  router.get('/:id/history', (req, res) => {
    res.json(getHistory('call', req.params.id));
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    const { lastInsertRowid } = run(
      `INSERT INTO calls (call_at, direction, handled_by_user_id, call_type, trade_id, job_type_id, lead_source_id,
        booked, not_booked_reason_id, cancellation_type, cancellation_reason_id, call_back_reason_id, job_number,
        suburb, notes, follow_up, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.callAt,
        b.direction || 'Inbound',
        b.handledByUserId || null,
        b.callType || 'Lead',
        b.tradeId || null,
        b.jobTypeId || null,
        b.leadSourceId || null,
        b.booked || '',
        b.notBookedReasonId || null,
        b.cancellationType || '',
        b.cancellationReasonId || null,
        b.callBackReasonId || null,
        b.jobNumber || '',
        b.suburb || '',
        b.notes || '',
        b.followUp ? 1 : 0,
        req.user.id,
      ]
    );
    res.status(201).json(toRow(get(`${SELECT_SQL} WHERE c.id = ?`, [lastInsertRowid])));
  });

  router.patch('/:id', (req, res) => {
    const existing = get('SELECT * FROM calls WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {};
    const next = {
      call_at: b.callAt ?? existing.call_at,
      direction: b.direction ?? existing.direction,
      handled_by_user_id: b.handledByUserId ?? existing.handled_by_user_id,
      call_type: b.callType ?? existing.call_type,
      trade_id: b.tradeId ?? existing.trade_id,
      job_type_id: b.jobTypeId ?? existing.job_type_id,
      lead_source_id: b.leadSourceId ?? existing.lead_source_id,
      booked: b.booked ?? existing.booked,
      not_booked_reason_id: b.notBookedReasonId ?? existing.not_booked_reason_id,
      cancellation_type: b.cancellationType ?? existing.cancellation_type,
      cancellation_reason_id: b.cancellationReasonId ?? existing.cancellation_reason_id,
      call_back_reason_id: b.callBackReasonId ?? existing.call_back_reason_id,
      job_number: b.jobNumber ?? existing.job_number,
      suburb: b.suburb ?? existing.suburb,
      notes: b.notes ?? existing.notes,
      follow_up: b.followUp !== undefined ? (b.followUp ? 1 : 0) : existing.follow_up,
    };
    run(
      `UPDATE calls SET call_at=?, direction=?, handled_by_user_id=?, call_type=?, trade_id=?, job_type_id=?,
        lead_source_id=?, booked=?, not_booked_reason_id=?, cancellation_type=?, cancellation_reason_id=?,
        call_back_reason_id=?, job_number=?, suburb=?, notes=?, follow_up=?, updated_at=datetime('now')
       WHERE id=?`,
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
        next.suburb,
        next.notes,
        next.follow_up,
        req.params.id,
      ]
    );
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
    run('UPDATE calls SET archived = ? WHERE id = ?', [req.body?.archived ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    run('DELETE FROM calls WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  return router;
}
