import { CURRENCY_FORMAT, money } from './xlsxHelpers.js';
import { utcToAdelaideDisplay } from './adelaideTime.js';

export const CALL_COLUMNS = [
  { key: 'archived', label: 'Archived' },
  { key: 'callAt', label: 'Date/time' },
  { key: 'direction', label: 'Contact Method' },
  { key: 'handledByName', label: 'Handled by' },
  { key: 'callType', label: 'Call type' },
  { key: 'tradeName', label: 'Trade' },
  { key: 'jobTypeName', label: 'Job type' },
  { key: 'leadSourceName', label: 'Lead source' },
  { key: 'booked', label: 'Booked' },
  { key: 'notBookedReasonName', label: 'Not booked reason' },
  { key: 'cancellationType', label: 'Cancellation type' },
  { key: 'cancellationReasonName', label: 'Cancellation reason' },
  { key: 'callBackReasonName', label: 'Call back reason' },
  { key: 'jobNumber', label: 'Job number' },
  { key: 'suburb', label: 'Suburb' },
  { key: 'notes', label: 'Notes' },
  { key: 'createdByName', label: 'Created by' },
  // created_at/changed_at are stamped by SQLite's datetime('now') — genuinely
  // UTC, unlike callAt/dateShown above (already Adelaide wall-clock strings
  // straight from the browser) — see utcToAdelaideDisplay()'s own comment.
  { key: 'createdAt', label: 'Created date/time (Adelaide)', value: (r) => utcToAdelaideDisplay(r.createdAt) },
  // Blank for any record with zero audit_log history at all (e.g. one
  // inserted directly, bypassing the app, before audit logging existed) —
  // see lib/audit.js's getLastEditedInfo(). Never a guess.
  { key: 'lastEditedByName', label: 'Last edited by' },
  { key: 'lastEditedAt', label: 'Last edited date/time (Adelaide)', value: (r) => utcToAdelaideDisplay(r.lastEditedAt) },
];

export const TECH_COLUMNS = [
  { key: 'archived', label: 'Archived' },
  { key: 'entryLabel', label: 'Entry type' },
  { key: 'dateShown', label: 'Date' },
  { key: 'technicianName', label: 'Technician' },
  { key: 'creditedTechnicianName', label: 'Credited technician' },
  // For a Quote Approved Later/Upsell/Call Back entry, this is the ORIGINAL
  // job's Job Number (used to locate/link it) — "New job number" below is
  // the separate one, where that entry type has one. For a New Job entry
  // this is simply its own Job Number (there's no second JN to distinguish).
  { key: 'jobNumber', label: 'Original job number' },
  // Only ever populated for a Quote Approved Later entry (the separate,
  // brand new AroFlo Job Number created for the approved work) or a Call
  // Back (the separate AroFlo Job Number created once the callback
  // attendance is booked) — distinct from Job number (the original job's
  // own JN, used above for linking) in both cases. Blank for every other
  // entry type and for any legacy record saved before this field existed.
  { key: 'newJobNumber', label: 'New job number' },
  { key: 'tradeName', label: 'Trade' },
  { key: 'jobTypeName', label: 'Job type' },
  // Only ever populated for a New Job entry (No Sale or Sale Made) or an
  // Existing Job — Upsell entry (its own, independently-editable copy of
  // the original job's suburb) — blank for every other entry type, which
  // reference an existing job rather than carrying their own Suburb.
  { key: 'suburb', label: 'Suburb' },
  { key: 'lead', label: 'Lead' },
  { key: 'inspectionSheet', label: 'Inspection sheet' },
  { key: 'optionSheet', label: 'Option sheet' },
  { key: 'knockback', label: 'Knock back' },
  { key: 'knockbackReasonName', label: 'Knock back reason' },
  { key: 'convertedLater', label: 'Converted later' },
  { key: 'invoiceNumber', label: 'Invoice number' },
  { key: 'invoiceDate', label: 'Invoice date' },
  // Blank (not $0.00) for any entry with no sale at all — e.g. a knock-back
  // or a call back never carries a sale value, and that absence must stay
  // visibly blank rather than implying a zero-dollar sale happened.
  { key: 'saleValueExGst', label: 'Sale value (ex GST)', value: (r) => (r.saleValueExGst === '' || r.saleValueExGst == null ? '' : money(r.saleValueExGst)), numFmt: CURRENCY_FORMAT },
  { key: 'reasonName', label: 'Call back / cancellation reason' },
  { key: 'comments', label: 'Comments' },
  { key: 'createdByName', label: 'Created by' },
  // created_at/changed_at are stamped by SQLite's datetime('now') — genuinely
  // UTC, unlike dateShown/invoiceDate above (already Adelaide wall-clock
  // strings straight from the browser) — see utcToAdelaideDisplay()'s own
  // comment.
  { key: 'createdAt', label: 'Created date/time (Adelaide)', value: (r) => utcToAdelaideDisplay(r.createdAt) },
  // Blank for any record with zero audit_log history at all (e.g. one
  // inserted directly, bypassing the app, before audit logging existed) —
  // see lib/audit.js's getLastEditedInfo(). Never a guess.
  { key: 'lastEditedByName', label: 'Last edited by' },
  { key: 'lastEditedAt', label: 'Last edited date/time (Adelaide)', value: (r) => utcToAdelaideDisplay(r.lastEditedAt) },
];
