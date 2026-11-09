import { all, get, run } from '../db/index.js';
import { normName } from './taskTypeMapping.js';

// AroFlo customer Lead Source value -> CRM Lead Source, managed by admins in
// Settings. Stored as JSON in the existing app_settings table (so it's in
// backup and restore) — no schema change. Read only by the Calls & Contacts
// AroFlo lookup, where it is a SUGGESTION ("Use this") — never applied on its
// own, never overwriting a staff choice, never saved until staff save the
// call. Changing a mapping only affects future lookups; no saved call is
// ever changed or backfilled.
//
// Resolution (one customer can carry both "Lead Source" and the older
// "Lead/Referral Source" field):
// - each value: an admin mapping first, else an exact-name match to one CRM
//   Lead Source, else unmapped (shown as reference only, never guessed);
// - one value, or several that resolve to the same CRM Lead Source -> one
//   result;
// - values that resolve differently (or any of them unmapped while another
//   differs) -> a conflict: shown, and left for staff.

const KEY = 'aroflo_lead_source_mappings';

function crmLeadSources() {
  return all("SELECT id, name FROM list_items WHERE category = 'lead_source' ORDER BY sort_order");
}

export function readLeadSourceMappings() {
  const row = get('SELECT value FROM app_settings WHERE key = ?', [KEY]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed?.mappings) ? parsed.mappings : [];
  } catch {
    return [];
  }
}

export function validateLeadSourceMappings(input) {
  if (!Array.isArray(input)) return { error: 'Mappings must be a list.' };
  const sources = crmLeadSources();
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const arofloValue = String(raw?.arofloValue || '').trim();
    const key = normName(arofloValue);
    if (!key) return { error: 'Each mapping needs an AroFlo Lead Source value.' };
    if (seen.has(key)) return { error: `"${arofloValue}" is mapped more than once — each AroFlo value can only have one mapping.` };
    seen.add(key);
    const ls = sources.find((s) => s.id === Number(raw?.leadSourceId));
    if (!ls) return { error: `"${arofloValue}": choose a CRM Lead Source.` };
    out.push({ arofloValue, leadSourceId: ls.id });
  }
  return { mappings: out };
}

export function saveLeadSourceMappings(mappings) {
  run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify({ version: 1, mappings })]
  );
}

/** Stored mappings with current CRM names; a deleted Lead Source is flagged. */
export function listLeadSourceMappingsForSettings() {
  const sources = crmLeadSources();
  return readLeadSourceMappings().map((m) => {
    const ls = sources.find((s) => s.id === Number(m.leadSourceId));
    return ls ? { ...m, leadSourceName: ls.name } : { ...m, broken: 'its CRM Lead Source no longer exists' };
  });
}

// One AroFlo value -> { leadSourceId, label, source } or null (unmapped).
function resolveValue(value, mappings, sources) {
  const key = normName(value);
  if (!key) return null;
  const stored = mappings.find((m) => normName(m.arofloValue) === key);
  if (stored) {
    const ls = sources.find((s) => s.id === Number(stored.leadSourceId));
    // A mapping whose Lead Source was deleted is ignored — never guessed,
    // and it doesn't fall back to a name match either.
    return ls ? { leadSourceId: ls.id, label: ls.name, source: 'mapping' } : null;
  }
  const exact = sources.filter((s) => normName(s.name) === key);
  return exact.length === 1 ? { leadSourceId: exact[0].id, label: exact[0].name, source: 'exact name' } : null;
}

/**
 * values: [{ field, value }] from the AroFlo customer record (blank values
 * already dropped). Returns one of:
 * { kind: 'none' }
 * { kind: 'mapped', leadSourceId, label, source, values }
 * { kind: 'unmapped', values }
 * { kind: 'conflict', values } — each value with its own { field, value, label }
 */
export function resolveLeadSourceValues(values) {
  const present = (values || []).filter((v) => v && String(v.value ?? '').trim());
  if (!present.length) return { kind: 'none', values: [] };
  const mappings = readLeadSourceMappings();
  const sources = crmLeadSources();
  const resolved = present.map((v) => ({ field: v.field, value: String(v.value).trim(), match: resolveValue(v.value, mappings, sources) }));
  const shown = resolved.map((r) => ({ field: r.field, value: r.value, label: r.match?.label ?? null }));
  // Distinct outcomes: a CRM Lead Source id, or the raw value when unmapped.
  const outcomes = new Set(resolved.map((r) => (r.match ? `id:${r.match.leadSourceId}` : `raw:${normName(r.value)}`)));
  if (outcomes.size > 1) return { kind: 'conflict', values: shown };
  const first = resolved[0];
  if (!first.match) return { kind: 'unmapped', values: shown };
  return { kind: 'mapped', leadSourceId: first.match.leadSourceId, label: first.match.label, source: first.match.source, values: shown };
}
