import ExcelJS from 'exceljs';
import { addTitleBlock, addDataTable, addFiltersSheet, filterSummaryLines } from './xlsxHelpers.js';
import { CALL_COLUMNS, TECH_COLUMNS } from './historyColumns.js';

const ENTRY_TYPE_LABELS = {
  new_job_no_sale: 'New Job — No Sale',
  new_job_sale_made: 'New Job — Sale Made',
  quote_approved_later: 'Existing Job — Quote Approved Later',
  existing_job_upsell: 'Existing Job — Upsell',
  call_back: 'Call Back',
  pending_cancellation: 'Pending Cancellation',
};

const WORK_COMPLETION_LABELS = {
  'Completed on this visit': 'Completed on this visit',
  'Install scheduled — different day': 'Install scheduled — different day',
};

function yesNo(v) {
  return v ? 'Yes' : 'No';
}

// "All" | "Active only" | "Archived only" — same tri-state the Advanced
// Filters panel's own Active/archived dropdown shows, reconstructed here
// from whichever of `status` (new) or `includeArchived` (legacy) the export
// request actually carried, so this label always matches what listCalls()/
// listTechEntries() themselves just did with those same two params.
function statusLabel(filters) {
  if (filters.status === 'archived') return 'Archived only';
  if (filters.status === 'all') return 'All (active + archived)';
  if (filters.status === 'active') return 'Active only';
  return filters.includeArchived === 'true' || filters.includeArchived === true ? 'All (active + archived)' : 'Active only';
}

function yesNoAllLabel(v) {
  if (v === 'yes') return 'Yes';
  if (v === 'no') return 'No';
  return 'All';
}

// ---------------------------------------------------------------------------
// Call History export
// ---------------------------------------------------------------------------
export function buildCallHistoryWorkbook(rows, filters, lookups) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const staffName = (id) => (id ? lookups?.staff?.get(String(id)) || `#${id}` : 'All');
  const tradeName = filters.tradeId ? lookups?.trades?.get(String(filters.tradeId)) || `#${filters.tradeId}` : 'All';
  const jobTypeName = filters.jobTypeId ? lookups?.jobTypes?.get(String(filters.jobTypeId)) || `#${filters.jobTypeId}` : 'All';

  // The short summary shown in the main sheet's own title block — just the
  // handful of filters most likely to matter at a glance. Every filter,
  // applied or not, is listed in full on the separate "Filters" sheet below.
  const extra = [
    `Staff (Handled by): ${staffName(filters.handledByUserId)}`,
    `Call type: ${filters.callType || 'All'}`,
    `Job number: ${filters.jobNumber ? filters.jobNumber : 'All'}`,
    `Status: ${statusLabel(filters)}`,
  ];

  const sheet = wb.addWorksheet('Call History');
  addTitleBlock(sheet, 'Call History Export', filterSummaryLines({ from: filters.from, to: filters.to, extra }));
  sheet.addRow([`${rows.length} call${rows.length === 1 ? '' : 's'} exported`]).font = { italic: true, color: { argb: 'FF555555' } };
  sheet.addRow([]);

  const dataRows = rows.map((r) => ({
    ...r,
    archived: yesNo(r.archived),
    callAt: (r.callAt || '').replace('T', ' '),
  }));
  addDataTable(sheet, CALL_COLUMNS, dataRows);

  // Every filter the Advanced Filters panel offers, in one place — "All"
  // (or "No"/blank) for anything not actually applied, so this sheet is
  // always a complete, literal record of exactly what this export does and
  // doesn't include, never just the handful summarised above.
  addFiltersSheet(wb, [
    ['Date range (from)', filters.from || 'Earliest'],
    ['Date range (to)', filters.to || 'Latest'],
    ['Keyword search', filters.q || '—'],
    ['Job number', filters.jobNumber || 'All'],
    ['Suburb', filters.suburb || 'All'],
    ['Trade', tradeName],
    ['Job type', jobTypeName],
    ['Contact Method', filters.direction || 'All'],
    ['Call type', filters.callType || 'All'],
    ['Booked', filters.booked || 'All'],
    ['Handled by', staffName(filters.handledByUserId)],
    ['Created by', staffName(filters.createdByUserId)],
    ['Cancellation type', filters.cancellationType || 'All'],
    ['Status', statusLabel(filters)],
  ]);

  return wb;
}

// ---------------------------------------------------------------------------
// Job (Technician & Sales) History export
// ---------------------------------------------------------------------------
export function buildJobHistoryWorkbook(rows, filters, lookups) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const techName = (id) => (id ? lookups?.technicians?.get(String(id)) || `#${id}` : 'All');
  const staffName = (id) => (id ? lookups?.staff?.get(String(id)) || `#${id}` : 'All');
  const tradeName = filters.tradeId ? lookups?.trades?.get(String(filters.tradeId)) || `#${filters.tradeId}` : 'All';
  const jobTypeName = filters.jobTypeId ? lookups?.jobTypes?.get(String(filters.jobTypeId)) || `#${filters.jobTypeId}` : 'All';
  const knockbackReasonName = filters.knockbackReasonId
    ? lookups?.knockbackReasons?.get(String(filters.knockbackReasonId)) || `#${filters.knockbackReasonId}`
    : 'All';
  const entryTypeName = filters.entryType ? ENTRY_TYPE_LABELS[filters.entryType] || filters.entryType : 'All';

  const extra = [
    `Technician: ${techName(filters.technicianId)}`,
    `Trade: ${tradeName}`,
    `Entry type: ${entryTypeName}`,
    `Job number: ${filters.jobNumber ? filters.jobNumber : 'All'}`,
    `Status: ${statusLabel(filters)}`,
  ];

  const sheet = wb.addWorksheet('Job History');
  addTitleBlock(sheet, 'Technician & Sales History Export', filterSummaryLines({ from: filters.from, to: filters.to, extra }));
  sheet.addRow([`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} exported`]).font = { italic: true, color: { argb: 'FF555555' } };
  sheet.addRow([]);

  const dataRows = rows.map((r) => ({
    ...r,
    archived: yesNo(r.archived),
    convertedLater: yesNo(r.convertedLater),
    knockback: yesNo(r.knockback),
  }));
  addDataTable(sheet, TECH_COLUMNS, dataRows);

  addFiltersSheet(wb, [
    ['Date range (from)', filters.from || 'Earliest'],
    ['Date range (to)', filters.to || 'Latest'],
    ['Keyword search', filters.q || '—'],
    ['Job number (either)', filters.jobNumber || 'All'],
    ['Original Job Number', filters.originalJobNumber || 'All'],
    ['New Job Number', filters.newJobNumber || 'All'],
    ['Suburb', filters.suburb || 'All'],
    ['Trade', tradeName],
    ['Job type', jobTypeName],
    ['Entry type', entryTypeName],
    ['Technician', techName(filters.technicianId)],
    ['Technician who completed the work', techName(filters.completingTechnicianId)],
    ['Sale Made', yesNoAllLabel(filters.saleMade)],
    ['Knockback', yesNoAllLabel(filters.knockback)],
    ['Knockback reason', knockbackReasonName],
    ['Work completed', WORK_COMPLETION_LABELS[filters.workCompletion] || 'All'],
    ['Converted Later', yesNoAllLabel(filters.convertedLater)],
    ['Has Call Back', yesNoAllLabel(filters.hasCallBack)],
    ['Has Pending Cancellation', yesNoAllLabel(filters.hasPendingCancellation)],
    ['Has Upsell', yesNoAllLabel(filters.hasUpsell)],
    ['Created by', staffName(filters.createdByUserId)],
    ['Status', statusLabel(filters)],
  ]);

  return wb;
}
