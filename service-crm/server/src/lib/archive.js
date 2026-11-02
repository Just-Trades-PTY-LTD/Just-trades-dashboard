import crypto from 'node:crypto';
import { all as getAll, get, run, transaction } from '../db/index.js';

// Manual archive / unarchive of Technician & Sales entries and calls, with
// their genuinely linked records. Nothing here runs on a schedule, by age,
// or on deployment — only when an admin chooses Archive / Unarchive on
// specific records and confirms the plan shown to them.
//
// Flow: planArchive() works out exactly which records an action touches
// (and which linked records it deliberately leaves alone) -> the admin is
// shown that plan -> applyArchive() rebuilds the plan, refuses if it no
// longer matches what was confirmed (the `token`), and applies every change
// in ONE transaction, so a failure anywhere rolls the whole action back.
//
// Linked rules:
// - Sale Made job: its own sale (job_id + source = sale_made_at_visit) is
//   archived with it. Unarchiving the job restores that sale ONLY if it was
//   archived by the same linked action and nothing has archived or
//   unarchived it since — a sale archived on its own stays archived.
// - Quote Approved Later sale: archiving it reverses only the conversion
//   that sale created (the job whose converted_by_sale_id is this sale).
//   Unarchiving re-applies it only if that job is still active and still an
//   unconverted Qualified No Sale knock-back.
// - Call: a Pending Cancellation call's linked cancellation follows the
//   same "only restore what was archived together" rule.
// Which records were archived together is read back from Activity history
// (audit_log), written in the same transaction — no new column needed.

export class ArchiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const KINDS = {
  new_job_no_sale: { table: 'jobs', entity: 'job', label: 'New Job — No Sale', where: 'had_sale_at_visit = 0' },
  new_job_sale_made: { table: 'jobs', entity: 'job', label: 'New Job — Sale Made', where: 'had_sale_at_visit = 1' },
  quote_approved_later: { table: 'sales', entity: 'sale', label: 'Quote Approved Later', where: "source = 'quote_approved_later' AND is_upsell = 0" },
  existing_job_upsell: { table: 'sales', entity: 'sale', label: 'Upsell', where: 'is_upsell = 1' },
  call_back: { table: 'call_backs', entity: 'call_back', label: 'Call Back', where: '1 = 1' },
  pending_cancellation: { table: 'pending_cancellations', entity: 'pending_cancellation', label: 'Pending Cancellation', where: '1 = 1' },
  call: { table: 'calls', entity: 'call', label: 'Call', where: '1 = 1' },
};

const TABLE_BY_ENTITY = { job: 'jobs', sale: 'sales', call_back: 'call_backs', pending_cancellation: 'pending_cancellations', call: 'calls' };

/** The row for `kind` + `id`, or null — the kind is checked against the row
 * itself, so an id that belongs to a different kind of record (ids overlap
 * between tables, and between Sale Made / Quote Approved Later / Upsell
 * sales) can never be acted on by mistake. */
export function findEntry(kind, id) {
  const k = KINDS[kind];
  if (!k) return null;
  return get(`SELECT * FROM ${k.table} WHERE id = ? AND ${k.where}`, [Number(id)]) || null;
}

function money(v) {
  return `$${(Number(v) || 0).toLocaleString('en-AU', { maximumFractionDigits: 2 })}`;
}
function saleLabel(s) {
  return `sale ${s.invoice_number ? `inv ${s.invoice_number}` : `#${s.id}`} (${money(s.sale_value_ex_gst)} ex GST)`;
}
function entryLabel(kind, row) {
  const k = KINDS[kind];
  if (kind === 'call') return `Call on ${String(row.call_at).slice(0, 16).replace('T', ' ')}${row.job_number ? ` — JN ${row.job_number}` : ''}`;
  if (k.table === 'sales') return `${k.label} — JN ${row.job_number}, ${saleLabel(row)}`;
  return `${k.label} — JN ${row.job_number}`;
}

/** Latest Activity-history entry for a record that changed its archived
 * state, or null. */
function latestArchiveEvent(entity, id) {
  const rows = getAll(
    `SELECT changes_json FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC`,
    [entity, id]
  );
  for (const r of rows) {
    const changes = JSON.parse(r.changes_json);
    if (changes.archived) return changes;
  }
  return null;
}

function eligibleForConversion(job) {
  return job && !job.archived && job.lead === 'Qualified' && !job.had_sale_at_visit && job.knockback === 1 && !job.converted_later;
}

function hasOtherActiveJobWithNumber(job) {
  return !!get(
    'SELECT id FROM jobs WHERE archived = 0 AND id <> ? AND lower(trim(job_number)) = lower(trim(?)) AND trim(job_number) <> ?',
    [job.id, job.job_number, '']
  );
}

/**
 * Works out what archiving (archived = true) or unarchiving one entry would
 * do. Returns { kind, id, archived, label, steps, notes } where each step is
 * one record change ({ entity, id, set, audit, description }) and notes are
 * linked records deliberately left unchanged. Throws ArchiveError if the
 * action isn't allowed.
 */
export function planArchive(kind, id, archived) {
  const row = findEntry(kind, id);
  if (!row) throw new ArchiveError('Entry not found.', 404);
  const k = KINDS[kind];
  const label = entryLabel(kind, row);
  if (!!row.archived === !!archived) {
    throw new ArchiveError(`${label} is already ${archived ? 'archived' : 'active'}.`);
  }
  const target = archived ? 1 : 0;
  const steps = [
    {
      entity: k.entity,
      id: row.id,
      set: { archived: target },
      audit: { archived: { from: row.archived ? 'Yes' : 'No', to: archived ? 'Yes' : 'No' } },
      description: `${archived ? 'Archive' : 'Unarchive'} ${label}`,
    },
  ];
  const notes = [];
  let convertingSaleNote = null;

  if (k.table === 'jobs' && !archived && hasOtherActiveJobWithNumber(row)) {
    throw new ArchiveError(`Can't unarchive ${label}: another active job already uses Job Number ${row.job_number}.`);
  }

  if (kind === 'new_job_sale_made') {
    const sale = get("SELECT * FROM sales WHERE job_id = ? AND source = 'sale_made_at_visit'", [row.id]);
    if (sale && archived) {
      if (sale.archived) {
        notes.push(`JN ${row.job_number}: its ${saleLabel(sale)} is already archived on its own and stays archived.`);
      } else {
        steps[0].audit.linked_sale_archived = { from: null, to: sale.id };
        steps.push({
          entity: 'sale',
          id: sale.id,
          set: { archived: 1 },
          audit: { archived: { from: 'No', to: 'Yes' }, archived_with_job: { from: null, to: row.id } },
          description: `Also archive its ${saleLabel(sale)}`,
        });
      }
    }
    if (sale && !archived) {
      const last = latestArchiveEvent('sale', sale.id);
      if (sale.archived && last?.archived_with_job?.to === row.id) {
        steps[0].audit.linked_sale_restored = { from: null, to: sale.id };
        steps.push({
          entity: 'sale',
          id: sale.id,
          set: { archived: 0 },
          audit: { archived: { from: 'Yes', to: 'No' }, restored_with_job: { from: null, to: row.id } },
          description: `Also restore its ${saleLabel(sale)} (archived together with this job)`,
        });
      } else if (sale.archived) {
        notes.push(`JN ${row.job_number}: its ${saleLabel(sale)} was archived separately, so it stays archived.`);
      }
    }
  }

  if (kind === 'new_job_no_sale' && archived) {
    const conv = row.converted_by_sale_id ? get('SELECT * FROM sales WHERE id = ?', [row.converted_by_sale_id]) : null;
    if (conv && !conv.archived) {
      // planMany drops this note when that sale is selected in the same action.
      convertingSaleNote = { saleId: conv.id, text: `JN ${row.job_number}: the Quote Approved Later ${saleLabel(conv)} that converted it is not changed and still counts as a sale.` };
      notes.push(convertingSaleNote.text);
    }
    if (get("SELECT 1 FROM follow_ups WHERE job_id = ? AND status = 'active'", [row.id])) notes.push(`JN ${row.job_number}: its open follow-up is not changed.`);
  }

  if (kind === 'quote_approved_later' && archived) {
    const job = get('SELECT * FROM jobs WHERE converted_by_sale_id = ?', [row.id]);
    if (job) {
      steps[0].audit.conversion_reversed_for_job = { from: null, to: job.id };
      steps.push({
        entity: 'job',
        id: job.id,
        set: { converted_later: 0, converted_by_sale_id: null },
        audit: { knockback: { from: 'Converted (quote approved later)', to: 'Yes' }, converted_by_sale: { from: row.id, to: null } },
        description: `Undo the "Converted later" this sale gave JN ${job.job_number}, so it counts as a knock-back again`,
      });
    }
    if (get('SELECT 1 FROM follow_ups WHERE closed_by_sale_id = ?', [row.id])) notes.push(`JN ${row.job_number}: a follow-up this sale closed stays closed.`);
  }

  if (kind === 'quote_approved_later' && !archived) {
    const last = latestArchiveEvent('sale', row.id);
    const jobId = last?.conversion_reversed_for_job?.to;
    if (jobId) {
      const job = get('SELECT * FROM jobs WHERE id = ?', [jobId]);
      if (eligibleForConversion(job)) {
        steps[0].audit.conversion_reapplied_for_job = { from: null, to: job.id };
        steps.push({
          entity: 'job',
          id: job.id,
          set: { converted_later: 1, converted_by_sale_id: row.id },
          audit: { knockback: { from: 'Yes', to: 'Converted (quote approved later)' }, converted_by_sale: { from: null, to: row.id } },
          description: `Mark JN ${job.job_number} "Converted later" by this sale again`,
        });
      } else {
        notes.push(
          `JN ${job?.job_number ?? '(deleted job)'} is not marked "Converted later" again: it is no longer an active, unconverted Qualified No Sale knock-back.`
        );
      }
    }
  }

  if (kind === 'call') {
    const pc = row.pending_cancellation_id ? get('SELECT * FROM pending_cancellations WHERE id = ?', [row.pending_cancellation_id]) : null;
    if (pc && archived) {
      if (pc.archived) notes.push(`JN ${pc.job_number}: its pending cancellation is already archived on its own and stays archived.`);
      else {
        steps.push({
          entity: 'pending_cancellation',
          id: pc.id,
          set: { archived: 1 },
          audit: { archived: { from: 'No', to: 'Yes' }, archived_with_call: { from: null, to: row.id } },
          description: `Also archive its pending cancellation (JN ${pc.job_number})`,
        });
      }
    }
    if (pc && !archived && pc.archived) {
      const last = latestArchiveEvent('pending_cancellation', pc.id);
      if (last?.archived_with_call?.to === row.id) {
        steps.push({
          entity: 'pending_cancellation',
          id: pc.id,
          set: { archived: 0 },
          audit: { archived: { from: 'Yes', to: 'No' }, restored_with_call: { from: null, to: row.id } },
          description: `Also restore its pending cancellation (JN ${pc.job_number}, archived together with this call)`,
        });
      } else notes.push(`JN ${pc.job_number}: its pending cancellation was archived separately, so it stays archived.`);
    }
  }

  return { kind, id: row.id, archived: !!archived, label, steps, notes, convertingSaleNote };
}

/** A fingerprint of exactly what a set of plans would change. */
export function planToken(plans) {
  const shape = plans.map((p) => p.steps.map((s) => [s.entity, s.id, s.set]));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

/** Plans several entries together. When two selected entries touch the same
 * record (e.g. a No Sale job and the Quote Approved Later sale that converted
 * it), the changes are merged into one update of that record rather than one
 * being dropped; the duplicate step stays listed (for the confirmation) but is
 * marked `merged` so it is never applied twice. */
export function planMany(items, archived) {
  if (!Array.isArray(items) || !items.length) throw new ArchiveError('Nothing selected.');
  const firstStep = new Map();
  const plans = [];
  const selected = new Set();
  for (const { kind, id } of items) {
    const sel = `${kind}:${Number(id)}`;
    if (selected.has(sel)) continue;
    selected.add(sel);
    const plan = planArchive(kind, id, archived);
    for (const step of plan.steps) {
      const key = `${step.entity}:${step.id}`;
      const first = firstStep.get(key);
      if (!first) {
        firstStep.set(key, step);
        continue;
      }
      for (const [col, val] of Object.entries(step.set)) {
        if (!(col in first.set)) first.set[col] = val;
      }
      for (const [col, val] of Object.entries(step.audit)) {
        if (!(col in first.audit)) first.audit[col] = val;
      }
      step.merged = true;
    }
    plans.push(plan);
  }
  for (const plan of plans) {
    const n = plan.convertingSaleNote;
    if (n && selected.has(`quote_approved_later:${n.saleId}`)) plan.notes = plan.notes.filter((t) => t !== n.text);
  }
  return plans;
}

/** Summary for the confirmation: counts by type, every change, every note. */
export function describePlans(plans) {
  const counts = {};
  plans.forEach((p) => {
    const label = KINDS[p.kind].label;
    counts[label] = (counts[label] || 0) + 1;
  });
  const linked = plans.flatMap((p) => p.steps.slice(1).map((s) => s.description));
  return {
    entries: plans.length,
    countsByType: counts,
    changes: plans.flatMap((p) => p.steps.map((s) => s.description)),
    linkedChanges: linked,
    notes: plans.flatMap((p) => p.notes),
    details: plans.flatMap((p) => p.details || []),
    token: planToken(plans),
  };
}

/** Re-plans inside one transaction, refuses unless the plan still matches
 * the `token` the admin confirmed, then applies every step and its Activity
 * history entry. Any failure rolls the whole action back. */
function applyConfirmed(buildPlans, token, userId) {
  return transaction(() => {
    const plans = buildPlans();
    const summary = describePlans(plans);
    if (!token || token !== summary.token) {
      throw new ArchiveError('The records affected have changed since you confirmed. Nothing was changed — please review and confirm again.', 409);
    }
    for (const plan of plans) {
      for (const step of plan.steps) {
        if (step.merged) continue;
        const cols = Object.keys(step.set);
        if (cols.length) {
          run(
            `UPDATE ${TABLE_BY_ENTITY[step.entity]} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
            [...cols.map((c) => step.set[c]), step.id]
          );
        }
        run('INSERT INTO audit_log (entity_type, entity_id, changes_json, changed_by_user_id) VALUES (?, ?, ?, ?)', [
          step.entity,
          step.id,
          JSON.stringify(step.audit),
          userId || null,
        ]);
      }
    }
    return summary;
  });
}

/** Applies confirmed archive / unarchive plans. `token` must match the plan
 * as it stands now — if anything changed since the admin confirmed, nothing
 * is applied. */
export function applyArchive(items, archived, token, userId) {
  return applyConfirmed(() => planMany(items, archived), token, userId);
}

// ---- Link an unlinked Quote Approved Later sale to its original job ----
// A QAL sale only links ("converts") its original knock-back job at the
// moment it is saved. If that job wasn't recorded as a Qualified No Sale
// knock-back at that moment (e.g. its knock-back was corrected afterwards),
// the sale stays "not linked" — the CRM never relinks on its own. This is
// the deliberate admin action to link it later: it only ever links the sale
// to the job it was saved against (sales.job_id), only if that job is
// eligible right now, and changes nothing else (no follow-up is closed).

/** Plan for linking QAL sale `saleId` to its original job, or throws an
 * ArchiveError saying exactly why it can't be linked. */
export function planLinkQal(saleId) {
  const sale = findEntry('quote_approved_later', saleId);
  if (!sale) throw new ArchiveError('Quote Approved Later entry not found.', 404);
  const label = entryLabel('quote_approved_later', sale);
  if (sale.archived) throw new ArchiveError(`${label} is archived. Unarchive it first.`);
  const already = get('SELECT * FROM jobs WHERE converted_by_sale_id = ?', [sale.id]);
  if (already) throw new ArchiveError(`${label} is already linked to JN ${already.job_number}. Nothing to do.`);
  const job = sale.job_id ? get('SELECT * FROM jobs WHERE id = ?', [sale.job_id]) : null;
  if (!job) throw new ArchiveError(`${label} has no original job on record to link to. Nothing was changed.`);
  const jn = `JN ${job.job_number} (visit ${job.visit_date})`;
  if (String(job.job_number).trim().toLowerCase() !== String(sale.job_number).trim().toLowerCase()) {
    throw new ArchiveError(`Can't link: the sale's Job Number (${sale.job_number}) no longer matches its original job, ${jn}. Nothing was changed.`);
  }
  if (job.converted_later) throw new ArchiveError(`Can't link: ${jn} is already marked "Converted later" by another sale. Nothing was changed.`);
  // Same definition of a knock-back the reports use (Qualified, no sale at
  // the visit) — deliberately NOT the stored knockback flag, which older
  // edits could leave out of step (Data Health check 8) and which is exactly
  // why such a sale didn't link when it was saved.
  if (job.archived || job.lead !== 'Qualified' || job.had_sale_at_visit) {
    throw new ArchiveError(
      `Can't link: ${jn} is not currently an active, Qualified, New Job — No Sale knock-back. Correct the job first if it should be. Nothing was changed.`
    );
  }
  if (sale.date_logged && job.visit_date && String(job.visit_date) > String(sale.date_logged)) {
    throw new ArchiveError(`Can't link: ${jn} is dated after this sale (${sale.date_logged}), so it can't be the job the sale converted. Nothing was changed.`);
  }
  const notes = [`After linking, JN ${job.job_number} counts as "Converted later" in reports instead of as an unconverted knock-back.`];
  if (get("SELECT 1 FROM follow_ups WHERE job_id = ? AND status = 'active'", [job.id])) {
    notes.push(`JN ${job.job_number}: its open follow-up is not changed — close it yourself if the quote was approved.`);
  }
  return {
    kind: 'quote_approved_later',
    id: sale.id,
    label,
    steps: [
      {
        entity: 'sale',
        id: sale.id,
        set: {},
        audit: { conversion_linked_to_job: { from: null, to: job.id } },
        description: `Link ${label} to its original knock-back job`,
      },
      {
        entity: 'job',
        id: job.id,
        set: { converted_later: 1, converted_by_sale_id: sale.id, ...(job.knockback ? {} : { knockback: 1 }) },
        audit: {
          knockback: { from: job.knockback ? 'Yes' : 'No (stored flag)', to: 'Converted (quote approved later)' },
          converted_by_sale: { from: null, to: sale.id },
        },
        description: `Mark ${jn} "Converted later" by this sale${
          job.knockback ? '' : ' (and correct its stored knock-back flag from No to Yes, which it should already be as a Qualified No Sale job)'
        }`,
      },
    ],
    notes,
  };
}

export function previewLinkQal(saleId) {
  return describePlans([planLinkQal(saleId)]);
}

export function applyLinkQal(saleId, token, userId) {
  return applyConfirmed(() => [planLinkQal(saleId)], token, userId);
}

// ---- Correct a job's stored knock-back flag (Data Health check 8) ----
// The stored flag should be Yes exactly when the job is a Qualified No Sale
// (the same rule leadRules.js applies whenever Lead is changed on an edit).
// Older edits could leave it out of step. This admin action corrects ONLY
// that flag on one job, after a preview. It never touches Lead, sheets,
// technician, dates, follow-ups or sales, and it refuses (changing nothing)
// when the job has an open follow-up or any Quote Approved Later / Converted
// Later link, so those are reviewed separately rather than changed here.

const yesNo = (v) => (v ? 'Yes' : 'No');

/** Why a stored-flag correction on this job needs separate review, if it
 * does — [] when nothing conflicts. */
export function knockbackFlagConflicts(job) {
  const conflicts = [];
  if (get("SELECT 1 FROM follow_ups WHERE job_id = ? AND status = 'active'", [job.id])) conflicts.push('an open follow-up');
  if (job.converted_later || job.converted_by_sale_id) conflicts.push('a Converted Later link');
  else if (get("SELECT 1 FROM sales WHERE job_id = ? AND source = 'quote_approved_later' AND is_upsell = 0 AND archived = 0", [job.id])) {
    conflicts.push('a Quote Approved Later sale saved against it');
  }
  return conflicts;
}

export function planKnockbackFlag(jobId) {
  const job = get('SELECT * FROM jobs WHERE id = ?', [Number(jobId)]);
  if (!job) throw new ArchiveError('Job not found.', 404);
  const jn = `JN ${job.job_number} (visit ${job.visit_date})`;
  if (job.archived) throw new ArchiveError(`${jn} is archived, so it isn't checked or corrected. Nothing was changed.`);
  if (job.lead !== 'Qualified' && job.lead !== 'Not Qualified') {
    throw new ArchiveError(`${jn} has no Lead Qualification recorded. Set Lead on the job first. Nothing was changed.`);
  }
  const expected = !job.had_sale_at_visit && job.lead === 'Qualified' ? 1 : 0;
  if ((job.knockback ? 1 : 0) === expected) {
    throw new ArchiveError(`${jn}'s stored knock-back flag is already correct (${yesNo(expected)}). Nothing to correct.`);
  }
  const conflicts = knockbackFlagConflicts(job);
  if (conflicts.length) {
    throw new ArchiveError(
      `Can't correct ${jn}'s knock-back flag because it has ${conflicts.join(' and ')}. Please review that separately — nothing was changed.`,
      409
    );
  }
  const visit = job.had_sale_at_visit ? 'Sale Made' : 'No Sale';
  return {
    kind: job.had_sale_at_visit ? 'new_job_sale_made' : 'new_job_no_sale',
    id: job.id,
    label: `JN ${job.job_number}`,
    details: [
      `Job: ${jn}, New Job — ${visit}`,
      `Current qualification: ${job.lead}`,
      `Current stored knock-back flag: ${yesNo(job.knockback)}`,
      `Correct stored knock-back flag: ${yesNo(expected)}`,
      `Report figures affected: none — knock-back, conversion and converted-later figures are worked out from Lead, not this flag. (Only a report or Job History filtered by "Knockback" will now list this job under "${yesNo(expected)}" instead of "${yesNo(job.knockback)}".)`,
      'Follow-ups affected: none (this job has no open follow-up)',
      'Converted Later links affected: none (this job has none)',
      'Lead, sheets, technician, dates, reasons and every other field: unchanged',
    ],
    steps: [
      {
        entity: 'job',
        id: job.id,
        set: { knockback: expected },
        audit: { stored_knockback_flag: { from: yesNo(job.knockback), to: yesNo(expected) } },
        description: `Change ${jn}'s stored knock-back flag from ${yesNo(job.knockback)} to ${yesNo(expected)}`,
      },
    ],
    notes: [],
  };
}

export function previewKnockbackFlag(jobId) {
  return describePlans([planKnockbackFlag(jobId)]);
}

export function applyKnockbackFlag(jobId, token, userId) {
  return applyConfirmed(() => [planKnockbackFlag(jobId)], token, userId);
}
