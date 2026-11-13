// Form text fields always hold text. A value from AroFlo or a lookup can
// arrive as a number (e.g. invoice 2300); turned into "2300" here so code
// that trims or compares text never breaks on it (a numeric invoice number
// once blanked the Technician & Sales form). Pure — nothing is saved.
export const TEXT_FIELDS = [
  'jobNumber', 'newJobNumber', 'invoiceNumber', 'invoiceDate', 'visitDate', 'installDate', 'dateLogged',
  'comments', 'notes', 'suburb', 'callAt',
];

export function textOnly(p) {
  if (!p || typeof p !== 'object') return p;
  const clean = { ...p };
  for (const k of TEXT_FIELDS) if (typeof clean[k] === 'number') clean[k] = String(clean[k]);
  return clean;
}
