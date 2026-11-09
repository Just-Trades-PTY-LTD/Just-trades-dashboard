import { all, get, run } from '../db/index.js';

// AroFlo task type -> CRM Trade / Job type, managed by admins in Settings.
// Stored as JSON in the existing app_settings table (so it's included in
// backup and restore) — no schema change. Read by the AroFlo lookup that
// both the Calls & Contacts form and the Technician & Sales form use, so the
// two always agree. Never changes a saved call or job: it only shapes the
// suggestion/blank-field fill of FUTURE lookups.
//
// Each AroFlo task type has at most one mapping (keyed by its name). Kinds:
// - full:      one Trade + one Job type.
// - tradeOnly: one Trade; the Job type is left for staff, who are shown the
//              listed choices (e.g. Gas and Water Piping -> Plumbing, choose
//              Gas Fitting or Burst Pipe). Never picks between them.
// - callback:  AroFlo's "Call Back" task type — recognised as a callback, but
//              it says nothing about the trade, so no Trade / Job type, and
//              the CRM entry/call type is never changed.
// An explicit mapping always overrides the exact-name fallback (an AroFlo
// task type whose name is exactly one CRM Job type, or "Trade Job type").
// A mapping whose Trade or Job type no longer exists is ignored (treated as
// unmapped) and flagged in Settings — never guessed.

const KEY = 'aroflo_task_type_mappings';
export const MAPPING_KINDS = ['full', 'tradeOnly', 'callback'];

export function normName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function crmTrades() {
  return all('SELECT id, name FROM trades ORDER BY sort_order').map((t) => ({
    ...t,
    jobTypes: all('SELECT id, name FROM job_types WHERE trade_id = ? ORDER BY sort_order', [t.id]),
  }));
}

export function readMappings() {
  const row = get('SELECT value FROM app_settings WHERE key = ?', [KEY]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed?.mappings) ? parsed.mappings : [];
  } catch {
    return [];
  }
}

// Validates and normalises an admin's full list. Returns { mappings } or
// { error }. Ids must exist; job types must belong to the chosen trade.
export function validateMappings(input) {
  if (!Array.isArray(input)) return { error: 'Mappings must be a list.' };
  const trades = crmTrades();
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const arofloTaskType = String(raw?.arofloTaskType || '').trim();
    const key = normName(arofloTaskType);
    if (!key) return { error: 'Each mapping needs an AroFlo task type name.' };
    if (seen.has(key)) return { error: `"${arofloTaskType}" is mapped more than once — each AroFlo task type can only have one mapping.` };
    seen.add(key);
    const kind = String(raw?.kind || '');
    if (!MAPPING_KINDS.includes(kind)) return { error: `"${arofloTaskType}": choose what it maps to.` };
    const entry = { arofloTaskType, kind, arofloId: raw?.arofloId ? String(raw.arofloId) : null };
    if (kind !== 'callback') {
      const trade = trades.find((t) => t.id === Number(raw?.tradeId));
      if (!trade) return { error: `"${arofloTaskType}": choose a Trade.` };
      entry.tradeId = trade.id;
      if (kind === 'full') {
        const jt = trade.jobTypes.find((j) => j.id === Number(raw?.jobTypeId));
        if (!jt) return { error: `"${arofloTaskType}": choose a Job type within ${trade.name}.` };
        entry.jobTypeId = jt.id;
      } else {
        const ids = [...new Set((raw?.choiceJobTypeIds || []).map(Number))];
        const valid = ids.filter((id) => trade.jobTypes.some((j) => j.id === id));
        if (valid.length !== ids.length) return { error: `"${arofloTaskType}": the Job type choices must belong to ${trade.name}.` };
        if (valid.length < 2) return { error: `"${arofloTaskType}": a Trade-only mapping needs at least two Job type choices for staff (otherwise map it in full).` };
        entry.choiceJobTypeIds = valid;
      }
    }
    out.push(entry);
  }
  return { mappings: out };
}

export function saveMappings(mappings) {
  run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify({ version: 1, mappings })]
  );
}

// A stored mapping checked against the CRM's current lists. Returns the
// resolved names, or { broken: reason } when its Trade / Job type is gone.
function resolveStored(m, trades) {
  if (m.kind === 'callback') return { ...m };
  const trade = trades.find((t) => t.id === Number(m.tradeId));
  if (!trade) return { ...m, broken: 'its Trade no longer exists in the CRM' };
  if (m.kind === 'full') {
    const jt = trade.jobTypes.find((j) => j.id === Number(m.jobTypeId));
    if (!jt) return { ...m, broken: `its Job type no longer exists under ${trade.name}` };
    return { ...m, tradeName: trade.name, jobTypeName: jt.name };
  }
  const choices = (m.choiceJobTypeIds || []).map((id) => trade.jobTypes.find((j) => j.id === Number(id))).filter(Boolean);
  if (choices.length < 2) return { ...m, broken: `fewer than two of its Job type choices still exist under ${trade.name}` };
  return { ...m, tradeName: trade.name, choices: choices.map((j) => ({ jobTypeId: j.id, name: j.name })) };
}

/** Every stored mapping, with current names and any "needs attention" reason. */
export function listMappingsForSettings() {
  const trades = crmTrades();
  return readMappings().map((m) => resolveStored(m, trades));
}

function exactNameMatch(taskType, trades) {
  const key = normName(taskType);
  if (!key) return null;
  const matches = [];
  for (const t of trades) {
    for (const jt of t.jobTypes) {
      if (normName(jt.name) === key || normName(`${t.name} ${jt.name}`) === key) matches.push({ trade: t, jt });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * What an AroFlo task type means for the forms:
 * { taskType, kind: 'full'|'tradeOnly'|'callback'|'none', source:
 *   'mapping'|'exact name'|null, tradeId, jobTypeId, label, choices }.
 */
export function resolveTaskType(taskType) {
  const name = String(taskType || '').trim();
  const none = { taskType: name, kind: 'none', source: null, tradeId: null, jobTypeId: null, label: null, choices: [] };
  if (!name) return none;
  const trades = crmTrades();
  const stored = readMappings().find((m) => normName(m.arofloTaskType) === normName(name));
  if (stored) {
    const m = resolveStored(stored, trades);
    if (!m.broken) {
      if (m.kind === 'callback') return { ...none, kind: 'callback', source: 'mapping' };
      if (m.kind === 'full') {
        return { ...none, kind: 'full', source: 'mapping', tradeId: m.tradeId, jobTypeId: m.jobTypeId, label: `${m.tradeName} — ${m.jobTypeName}` };
      }
      return { ...none, kind: 'tradeOnly', source: 'mapping', tradeId: m.tradeId, label: m.tradeName, choices: m.choices };
    }
    // A broken mapping is treated as unmapped — never guessed, and it
    // doesn't fall back to a name match either.
    return none;
  }
  const exact = exactNameMatch(name, trades);
  if (exact) {
    return { ...none, kind: 'full', source: 'exact name', tradeId: exact.trade.id, jobTypeId: exact.jt.id, label: `${exact.trade.name} — ${exact.jt.name}` };
  }
  return none;
}
