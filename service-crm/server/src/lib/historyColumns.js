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
];

export const TECH_COLUMNS = [
  { key: 'archived', label: 'Archived' },
  { key: 'entryLabel', label: 'Entry type' },
  { key: 'dateShown', label: 'Date' },
  { key: 'technicianName', label: 'Technician' },
  { key: 'creditedTechnicianName', label: 'Credited technician' },
  { key: 'jobNumber', label: 'Job number' },
  // Only ever populated for a Quote Approved Later entry — the separate,
  // brand new AroFlo Job Number created for the approved work, distinct
  // from Job number (the original visit's JN, used above for linking).
  // Blank for every other entry type and for any legacy Quote Approved
  // Later record saved before this field existed.
  { key: 'newJobNumber', label: 'New job number' },
  { key: 'tradeName', label: 'Trade' },
  { key: 'jobTypeName', label: 'Job type' },
  // Only ever populated for a New Job entry (No Sale or Sale Made) — blank
  // for every other entry type, which reference an existing job rather than
  // carrying their own Suburb.
  { key: 'suburb', label: 'Suburb' },
  { key: 'lead', label: 'Lead' },
  { key: 'inspectionSheet', label: 'Inspection sheet' },
  { key: 'optionSheet', label: 'Option sheet' },
  { key: 'knockback', label: 'Knock back' },
  { key: 'knockbackReasonName', label: 'Knock back reason' },
  { key: 'convertedLater', label: 'Converted later' },
  { key: 'invoiceNumber', label: 'Invoice number' },
  { key: 'invoiceDate', label: 'Invoice date' },
  { key: 'saleValueExGst', label: 'Sale value (ex GST)' },
  { key: 'reasonName', label: 'Call back / cancellation reason' },
  { key: 'comments', label: 'Comments' },
];
