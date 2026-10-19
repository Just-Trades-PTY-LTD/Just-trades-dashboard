import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { utcToAdelaideDisplay } from '../lib/adelaideTime.js';
import { classifyRating } from '../lib/reviewRating.js';

const SELECT_SQL = `
  SELECT r.*, cu.name AS created_by_name, lu.name AS last_edited_by_name
  FROM reviews r
  LEFT JOIN users cu ON cu.id = r.created_by_user_id
  LEFT JOIN users lu ON lu.id = r.last_edited_by_user_id
`;

function technicianNamesFor(reviewIds) {
  if (!reviewIds.length) return {};
  const placeholders = reviewIds.map(() => '?').join(',');
  const rows = all(
    `SELECT rt.review_id, t.id AS technician_id, t.name AS technician_name
     FROM review_technicians rt JOIN technicians t ON t.id = rt.technician_id
     WHERE rt.review_id IN (${placeholders})
     ORDER BY t.sort_order`,
    reviewIds
  );
  const map = {};
  rows.forEach((r) => {
    (map[r.review_id] ||= []).push({ id: r.technician_id, name: r.technician_name });
  });
  return map;
}

function toRow(r, technicians) {
  return {
    id: r.id,
    reviewDate: r.review_date,
    rating: r.rating,
    classification: classifyRating(r.rating),
    source: r.source,
    reviewLinkSent: r.review_link_sent,
    jobNumber: r.job_number,
    notes: r.notes,
    technicians: technicians || [],
    createdByUserId: r.created_by_user_id,
    createdByName: r.created_by_name || '',
    createdAt: utcToAdelaideDisplay(r.created_at),
    lastEditedByUserId: r.last_edited_by_user_id,
    lastEditedByName: r.last_edited_by_name || '',
    updatedAt: utcToAdelaideDisplay(r.updated_at),
  };
}

function setTechnicians(reviewId, technicianIds) {
  run('DELETE FROM review_technicians WHERE review_id = ?', [reviewId]);
  // De-duplicated — selecting the same technician twice in the form must
  // never attempt a second INSERT against the (review_id, technician_id)
  // primary key, which would otherwise fail the whole save.
  const uniqueIds = [...new Set((technicianIds || []).filter(Boolean).map(Number))];
  uniqueIds.forEach((technicianId) => {
    run('INSERT INTO review_technicians (review_id, technician_id) VALUES (?, ?)', [reviewId, technicianId]);
  });
}

// `status` mirrors Calls/Jobs' own tri-state status filter for consistency,
// even though reviews have no archived column (not requested) — only 'all'
// (the default, and the only value this route currently ever receives) has
// any effect; the others are accepted harmlessly for forward compatibility.
export function listReviews({ from, to, technicianId, rating, ratingClass, reviewLinkSent, jobNumber, q } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('r.review_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('r.review_date <= ?');
    params.push(to);
  }
  if (rating) {
    where.push('r.rating = ?');
    params.push(rating);
  }
  if (reviewLinkSent) {
    where.push('r.review_link_sent = ?');
    params.push(reviewLinkSent);
  }
  if (jobNumber) {
    where.push('lower(trim(r.job_number)) = ?');
    params.push(String(jobNumber).trim().toLowerCase());
  }
  if (q && String(q).trim()) {
    const key = `%${String(q).trim().toLowerCase()}%`;
    where.push('(lower(r.job_number) LIKE ? OR lower(r.notes) LIKE ?)');
    params.push(key, key);
  }
  if (technicianId) {
    where.push('r.id IN (SELECT review_id FROM review_technicians WHERE technician_id = ?)');
    params.push(technicianId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let rows = all(`${SELECT_SQL} ${whereSql} ORDER BY r.review_date DESC, r.id DESC`, params);
  // Rating classification (Positive/Neutral/Negative) is never stored, so
  // filtering by it happens here in JS against the same classifyRating()
  // every other figure uses, rather than a second, separately-maintained SQL
  // expression that could drift from it.
  if (ratingClass) rows = rows.filter((r) => classifyRating(r.rating) === ratingClass);
  const technicians = technicianNamesFor(rows.map((r) => r.id));
  return rows.map((r) => toRow(r, technicians[r.id]));
}

export function createReviewsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json(listReviews(req.query));
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.reviewDate) return res.status(400).json({ error: 'Please choose a Review Date before saving.' });
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Please select a Star Rating from 1 to 5 before saving.' });
    }
    if (!Array.isArray(b.technicianIds) || b.technicianIds.length === 0) {
      return res.status(400).json({ error: 'Please select at least one Technician before saving.' });
    }
    const id = transaction(() => {
      const { lastInsertRowid } = run(
        `INSERT INTO reviews (review_date, rating, source, review_link_sent, job_number, notes, created_by_user_id, last_edited_by_user_id)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
        [b.reviewDate, rating, b.reviewLinkSent || '', b.jobNumber || '', b.notes || '', req.user.id, req.user.id]
      );
      setTechnicians(lastInsertRowid, b.technicianIds);
      return lastInsertRowid;
    });
    const technicians = technicianNamesFor([id]);
    res.status(201).json(toRow(get(`${SELECT_SQL} WHERE r.id = ?`, [id]), technicians[id]));
  });

  router.patch('/:id', (req, res) => {
    const existing = get('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Review not found.' });
    const b = req.body || {};
    const next = {
      review_date: b.reviewDate ?? existing.review_date,
      rating: b.rating !== undefined ? Number(b.rating) : existing.rating,
      review_link_sent: b.reviewLinkSent ?? existing.review_link_sent,
      job_number: b.jobNumber ?? existing.job_number,
      notes: b.notes ?? existing.notes,
    };
    if (!Number.isInteger(next.rating) || next.rating < 1 || next.rating > 5) {
      return res.status(400).json({ error: 'Please select a Star Rating from 1 to 5 before saving.' });
    }
    const technicianIds = b.technicianIds !== undefined ? b.technicianIds : null;
    if (technicianIds !== null && (!Array.isArray(technicianIds) || technicianIds.length === 0)) {
      return res.status(400).json({ error: 'Please select at least one Technician before saving.' });
    }
    transaction(() => {
      run(
        `UPDATE reviews SET review_date=?, rating=?, review_link_sent=?, job_number=?, notes=?,
          last_edited_by_user_id=?, updated_at=datetime('now') WHERE id=?`,
        [next.review_date, next.rating, next.review_link_sent, next.job_number, next.notes, req.user.id, req.params.id]
      );
      if (technicianIds !== null) setTechnicians(Number(req.params.id), technicianIds);
    });
    const technicians = technicianNamesFor([Number(req.params.id)]);
    res.json(toRow(get(`${SELECT_SQL} WHERE r.id = ?`, [req.params.id]), technicians[Number(req.params.id)]));
  });

  return router;
}
