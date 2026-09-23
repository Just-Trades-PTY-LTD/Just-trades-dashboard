import ExcelJS from 'exceljs';
import { addTitleBlock, addDataTable, filterSummaryLines } from './xlsxHelpers.js';
import { CALL_COLUMNS, TECH_COLUMNS } from './historyColumns.js';

const ENTRY_TYPE_LABELS = {
  new_job_no_sale: 'New Job — No Sale',
  new_job_sale_made: 'New Job — Sale Made',
  quote_approved_later: 'Existing Job — Quote Approved Later',
  call_back: 'Call Back',
  pending_cancellation: 'Pending Cancellation',
};

function yesNo(v) {
  return v ? 'Yes' : 'No';
}

// ---------------------------------------------------------------------------
// Call History export
// ---------------------------------------------------------------------------
export function buildCallHistoryWorkbook(rows, filters, staffLookup) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const staffName = filters.handledByUserId ? staffLookup?.get(String(filters.handledByUserId)) || `#${filters.handledByUserId}` : 'All';
  const extra = [
    `Staff: ${staffName}`,
    `Call type: ${filters.callType || 'All'}`,
    `Job number: ${filters.jobNumber ? filters.jobNumber : 'All'}`,
    `Include archived: ${filters.includeArchived === 'true' || filters.includeArchived === true ? 'Yes' : 'No'}`,
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

  return wb;
}

// ---------------------------------------------------------------------------
// Job (Technician & Sales) History export
// ---------------------------------------------------------------------------
export function buildJobHistoryWorkbook(rows, filters, lookups) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const techName = filters.technicianId ? lookups?.technicians?.get(String(filters.technicianId)) || `#${filters.technicianId}` : 'All';
  const tradeName = filters.tradeId ? lookups?.trades?.get(String(filters.tradeId)) || `#${filters.tradeId}` : 'All';
  const entryTypeName = filters.entryType ? ENTRY_TYPE_LABELS[filters.entryType] || filters.entryType : 'All';
  const extra = [
    `Technician: ${techName}`,
    `Trade: ${tradeName}`,
    `Entry type: ${entryTypeName}`,
    `Job number: ${filters.jobNumber ? filters.jobNumber : 'All'}`,
    `Include archived: ${filters.includeArchived === 'true' || filters.includeArchived === true ? 'Yes' : 'No'}`,
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

  return wb;
}
