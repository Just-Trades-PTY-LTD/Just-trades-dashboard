// One place that turns AroFlo's values into the types the CRM screens expect.
// AroFlo is inconsistent: invoice numbers arrive as numbers, some fields as
// nested objects, others missing. Every value the lookups pass to the
// browser goes through these, so a screen never receives an unexpected type
// (a numeric invoice number once blanked the Technician & Sales form).

/** Text: a string (trimmed) or a number turned into text; anything else ''. */
export function asText(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** Text or null (for fields where "nothing" is null, not ''). */
export function asTextOrNull(v) {
  const t = asText(v);
  return t === '' ? null : t;
}

/** Money: a finite number (numeric strings accepted), otherwise null. */
export function asMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[$,\s]/g, '')))) return Number(v.replace(/[$,\s]/g, ''));
  return null;
}
