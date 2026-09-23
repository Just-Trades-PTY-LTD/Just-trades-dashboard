import ExcelJS from 'exceljs';
import { HEADER_FILL, HEADER_FONT, addTitleBlock, addSectionHeading, addDataTable, filterSummaryLines } from './xlsxHelpers.js';

function money(v) {
  return Number(v || 0);
}

function addKpiTable(sheet, rows) {
  const header = sheet.addRow(['Figure', 'Value']);
  header.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  rows.forEach(([label, value]) => sheet.addRow([label, value]));
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 20;
  sheet.addRow([]);
}

// ---------------------------------------------------------------------------
// Calls report workbook
// ---------------------------------------------------------------------------
export function buildCallsWorkbook(data, filters, staffLookup) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const staffName = filters.handledByUserId ? staffLookup?.get(String(filters.handledByUserId)) || `#${filters.handledByUserId}` : 'All';

  const summary = wb.addWorksheet('Summary');
  addTitleBlock(summary, 'Calls Report — Summary', filterSummaryLines({ from: filters.from, to: filters.to, extra: [`Staff: ${staffName}`] }));
  addKpiTable(summary, [
    ['Total calls', data.kpis.total],
    ['Inbound calls', data.kpis.inboundCount],
    ['Outbound calls', data.kpis.outboundCount],
    ['Leads', data.kpis.leadsCount],
    ['Booked leads', data.kpis.bookedCount],
    ['Booking rate', `${data.kpis.bookingRate}%`],
    ['Quotes approved', data.kpis.quotesApproved],
    ['Call back requests', data.kpis.callBackRequests],
    ['New Job Cancellations', data.kpis.newJobCancellations],
    ['Pending Cancellations', data.kpis.pendingCancellations],
  ]);

  const byStaff = wb.addWorksheet('By staff');
  addTitleBlock(byStaff, 'Calls Report — By Staff', filterSummaryLines({ from: filters.from, to: filters.to, extra: [`Staff: ${staffName}`] }));
  addDataTable(
    byStaff,
    [
      { key: 'name', label: 'Staff', width: 24 },
      { key: 'total', label: 'Total calls' },
      { key: 'inbound', label: 'Inbound' },
      { key: 'outbound', label: 'Outbound' },
      { key: 'leads', label: 'Leads' },
      { key: 'booked', label: 'Booked' },
      { key: 'rate', label: 'Booking rate', value: (r) => `${r.rate}%` },
    ],
    data.staffPerf
  );

  const breakdowns = wb.addWorksheet('Breakdowns');
  addTitleBlock(breakdowns, 'Calls Report — Breakdowns', filterSummaryLines({ from: filters.from, to: filters.to, extra: [`Staff: ${staffName}`] }));

  addSectionHeading(breakdowns, 'Calls by trade');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Trade', width: 24 },
    { key: 'value', label: 'Calls' },
  ], data.byTrade);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'Leads by referral source');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Referral source', width: 24 },
    { key: 'value', label: 'Leads' },
  ], data.bySourcePie);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'Leads by source — booked vs not');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Referral source', width: 24 },
    { key: 'Booked', label: 'Booked' },
    { key: 'Not booked', label: 'Not booked' },
  ], data.bySourceStack);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, "Why leads aren't booking");
  addDataTable(breakdowns, [
    { key: 'name', label: 'Reason', width: 28 },
    { key: 'value', label: 'Count' },
  ], data.notBookedReasons);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'New Job Cancellation reasons');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Reason', width: 28 },
    { key: 'value', label: 'Count' },
  ], data.newCancelReasons);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'Pending Cancellation reasons');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Reason', width: 28 },
    { key: 'value', label: 'Count' },
  ], data.pendingCancelReasons);
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'Calls over time');
  addDataTable(breakdowns, [
    { key: 'date', label: 'Date', width: 14 },
    { key: 'count', label: 'Calls' },
  ], data.trend);

  return wb;
}

// ---------------------------------------------------------------------------
// Technician & sales report workbook
// ---------------------------------------------------------------------------
// By trade keeps its existing column layout (unaffected by the
// qualified/unqualified reordering, which only applies to the Summary and
// By technician sheets, matching the on-screen report).
const TECH_TABLE_COLUMNS = (nameLabel) => [
  { key: 'label', label: nameLabel, width: 22 },
  { key: 'jobsAttended', label: 'Jobs' },
  { key: 'totalSaleExGst', label: 'Value (ex GST)', value: (r) => money(r.totalSaleExGst), width: 16 },
  { key: 'avgSaleExGst', label: 'Avg sale', value: (r) => Number((r.avgSaleExGst || 0).toFixed(2)), width: 14 },
  { key: 'knockbacks', label: 'Knock backs' },
  { key: 'convertedLaterCount', label: 'Converted later' },
  { key: 'conversionRate', label: 'Conversion %', value: (r) => `${r.conversionRate}%` },
  { key: 'qualifiedJobs', label: 'Qual. leads' },
  { key: 'knockbackRate', label: 'Knock-back %', value: (r) => `${r.knockbackRate}%` },
  { key: 'sales', label: 'Sales' },
  { key: 'callBacks', label: 'Call backs' },
  { key: 'pendingCancellations', label: 'Pending cancel.' },
];

// By technician: Total Jobs and Qualified Jobs lead, immediately adjacent;
// Unqualified Jobs appears later with the remaining figures — matching the
// on-screen "By technician" table's column order.
const TECH_BY_TECHNICIAN_COLUMNS = [
  { key: 'label', label: 'Technician', width: 22 },
  { key: 'jobsAttended', label: 'Total Jobs' },
  { key: 'qualifiedJobs', label: 'Qualified Jobs' },
  { key: 'totalSaleExGst', label: 'Value (ex GST)', value: (r) => money(r.totalSaleExGst), width: 16 },
  { key: 'avgSaleExGst', label: 'Avg sale', value: (r) => Number((r.avgSaleExGst || 0).toFixed(2)), width: 14 },
  { key: 'knockbacks', label: 'Knock backs' },
  { key: 'convertedLaterCount', label: 'Converted later' },
  { key: 'conversionRate', label: 'Conversion %', value: (r) => `${r.conversionRate}%` },
  { key: 'knockbackRate', label: 'Knock-back %', value: (r) => `${r.knockbackRate}%` },
  { key: 'sales', label: 'Sales' },
  { key: 'unqualifiedJobs', label: 'Unqualified Jobs' },
  { key: 'callBacks', label: 'Call backs' },
  { key: 'pendingCancellations', label: 'Pending cancel.' },
];

export function buildTechWorkbook(data, filters, lookups) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Just Trades CRM';
  wb.created = new Date();

  const techName = filters.technicianId ? lookups?.technicians?.get(String(filters.technicianId)) || `#${filters.technicianId}` : 'All';
  const tradeName = filters.tradeId ? lookups?.trades?.get(String(filters.tradeId)) || `#${filters.tradeId}` : 'All';
  const extra = [`Technician: ${techName}`, `Trade: ${tradeName}`];

  const summary = wb.addWorksheet('Summary');
  addTitleBlock(summary, 'Technician & Sales Report — Summary', filterSummaryLines({ from: filters.from, to: filters.to, extra }));
  const c = data.company;
  addKpiTable(summary, [
    ['Total Jobs', c.jobsAttended],
    ['Qualified Jobs', c.qualifiedJobs],
    ['Total sale value (ex GST)', money(c.totalSaleExGst)],
    ['Average sale (ex GST)', Number((c.avgSaleExGst || 0).toFixed(2))],
    ['Knock backs', c.knockbacks],
    ['Conversion rate', `${c.conversionRate}%`],
    ['Knock-back rate', `${c.knockbackRate}%`],
    ['Converted later', c.convertedLaterCount],
    ['Sales (invoices)', c.sales],
    ['Unqualified Jobs', c.unqualifiedJobs],
    ['Call backs', c.callBacks],
    ['Pending cancellations', c.pendingCancellations],
    ['Inspection sheet completion', `${c.inspectionRate}%`],
    ['Option sheet completion', `${c.optionRate}%`],
  ]);

  const byTrade = wb.addWorksheet('By trade');
  addTitleBlock(byTrade, 'Technician & Sales Report — By Trade', filterSummaryLines({ from: filters.from, to: filters.to, extra }));
  addDataTable(
    byTrade,
    TECH_TABLE_COLUMNS('Trade').map((col) => (col.key === 'label' ? { ...col } : col)),
    data.byTrade.map((r) => ({ ...r, label: r.trade }))
  );

  const byTechnician = wb.addWorksheet('By technician');
  addTitleBlock(byTechnician, 'Technician & Sales Report — By Technician', filterSummaryLines({ from: filters.from, to: filters.to, extra }));
  const techCols = [
    ...TECH_BY_TECHNICIAN_COLUMNS,
    { key: 'inspectionRate', label: 'Insp. sheet', value: (r) => `${r.inspectionRate}%` },
    { key: 'optionRate', label: 'Option sheet', value: (r) => `${r.optionRate}%` },
  ];
  addDataTable(
    byTechnician,
    techCols,
    data.byTechnician.map((r) => ({ ...r, label: r.name }))
  );

  const charts = wb.addWorksheet('Charts data');
  addTitleBlock(charts, 'Technician & Sales Report — Charts Data', filterSummaryLines({ from: filters.from, to: filters.to, extra }));

  addSectionHeading(charts, 'Sale value by trade (ex GST)');
  addDataTable(charts, [
    { key: 'name', label: 'Trade', width: 22 },
    { key: 'value', label: 'Value (ex GST)', value: (r) => money(r.value) },
  ], data.salesByTradePie);
  charts.addRow([]);

  addSectionHeading(charts, 'Jobs, qualified leads & sales by trade');
  addDataTable(charts, [
    { key: 'name', label: 'Trade', width: 22 },
    { key: 'Jobs', label: 'Jobs' },
    { key: 'Qualified leads', label: 'Qualified leads' },
    { key: 'Sales', label: 'Sales' },
  ], data.jobsOppSalesByTrade);
  charts.addRow([]);

  addSectionHeading(charts, 'Sales over time (ex GST)');
  addDataTable(charts, [
    { key: 'period', label: 'Period', width: 14 },
    { key: 'value', label: 'Value (ex GST)', value: (r) => money(r.value) },
    { key: 'count', label: 'Sales count' },
  ], data.trend);

  return wb;
}
