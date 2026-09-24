// The stored value for the two original options is kept exactly as it was
// ('Inbound' / 'Outbound') so existing saved calls are never touched — only
// the label shown for them changes. New contact methods store their label
// as the value directly, matching the pattern used elsewhere in this app
// (e.g. Lead's 'Qualified' / 'Not Qualified').
export const CONTACT_METHOD_OPTIONS = [
  { id: 'Inbound', name: 'Inbound Call' },
  { id: 'Outbound', name: 'Outbound Call' },
  { id: 'Text Message', name: 'Text Message' },
  { id: 'Email', name: 'Email' },
  { id: 'Other / N/A', name: 'Other / N/A' },
];

const LABEL_BY_VALUE = Object.fromEntries(CONTACT_METHOD_OPTIONS.map((o) => [o.id, o.name]));

export function contactMethodLabel(value) {
  return LABEL_BY_VALUE[value] || value || '—';
}
