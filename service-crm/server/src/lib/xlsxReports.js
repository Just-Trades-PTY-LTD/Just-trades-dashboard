import ExcelJS from 'exceljs';
import { HEADER_FILL, HEADER_FONT, CURRENCY_FORMAT, money, addTitleBlock, addSectionHeading, addDataTable, filterSummaryLines } from './xlsxHelpers.js';

// Rows are [label, value] for a plain figure, or [label, value, numFmt] when
// the value cell needs a display format (e.g. CURRENCY_FORMAT) — these KPI
// rows mix counts, percentages and money in the same two generic columns,
// so the format has to travel with the row rather than the column.
function addKpiTable(sheet, rows) {
  const header = sheet.addRow(['Figure', 'Value']);
  header.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  rows.forEach(([label, value, numFmt]) => {
    const row = sheet.addRow([label, value]);
    if (numFmt) row.getCell(2).numFmt = numFmt;
  });
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
    ['Total Contacts', data.kpis.total],
    ['Inbound Calls', data.kpis.inboundCount],
    ['Outbound Calls', data.kpis.outboundCount],
    ['Text Messages', data.kpis.textMessageCount],
    ['Emails', data.kpis.emailCount],
    ['Other / N/A', data.kpis.otherContactCount],
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
      { key: 'total', label: 'Total Contacts' },
      { key: 'inbound', label: 'Inbound Calls' },
      { key: 'outbound', label: 'Outbound Calls' },
      { key: 'textMessage', label: 'Text Messages' },
      { key: 'email', label: 'Emails' },
      { key: 'otherContact', label: 'Other / N/A' },
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
  breakdowns.addRow([]);

  addSectionHeading(breakdowns, 'Inbound Calls by Time of Day');
  addDataTable(breakdowns, [
    { key: 'name', label: 'Hour', width: 20 },
    { key: 'value', label: 'Inbound Calls' },
  ], data.inboundByHour);

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
  { key: 'totalSaleExGst', label: 'Value (ex GST)', value: (r) => money(r.totalSaleExGst), numFmt: CURRENCY_FORMAT, width: 16 },
  { key: 'avgSaleExGst', label: 'Avg sale', value: (r) => money(r.avgSaleExGst), numFmt: CURRENCY_FORMAT, width: 14 },
  { key: 'knockbacks', label: 'Knock backs' },
  { key: 'convertedLaterCount', label: 'Converted later' },
  { key: 'conversionRate', label: 'Conversion %', value: (r) => `${r.conversionRate}%` },
  { key: 'qualifiedJobs', label: 'Qual. leads' },
  { key: 'sales', label: 'Sales' },
  { key: 'callBacks', label: 'Call backs' },
  { key: 'pendingCancellations', label: 'Pending cancel.' },
];

// By technician: Total Jobs and Qualified Jobs lead, immediately adjacent.
// Sales / Converted Later / Actual Knockbacks / Adjusted Knockbacks /
// Conversion % are one cluster of "main performance figures", each
// appearing exactly once — matching the on-screen "By technician" table's
// column order. Actual Knockbacks and Conversion % are the same (renamed)
// figures as the old Knock backs / Conversion rate columns used to be — see
// services/reports.js for the calculation, unchanged by this file.
const TECH_BY_TECHNICIAN_COLUMNS = [
  { key: 'label', label: 'Technician', width: 22 },
  { key: 'jobsAttended', label: 'Total Jobs' },
  { key: 'qualifiedJobs', label: 'Qualified Jobs' },
  { key: 'sales', label: 'Sales' },
  { key: 'convertedLaterCredits', label: 'Converted Later' },
  { key: 'actualKnockbacks', label: 'Actual Knockbacks' },
  { key: 'adjustedKnockbacks', label: 'Adjusted Knockbacks' },
  { key: 'bonusConversionRate', label: 'Conversion %', value: (r) => `${(r.bonusConversionRate ?? 0).toFixed(2)}%` },
  { key: 'totalSaleExGst', label: 'Value (ex GST)', value: (r) => money(r.totalSaleExGst), numFmt: CURRENCY_FORMAT, width: 16 },
  { key: 'avgSaleExGst', label: 'Average Sale', value: (r) => money(r.avgSaleExGst), numFmt: CURRENCY_FORMAT, width: 14 },
  { key: 'unqualifiedJobs', label: 'Unqualified Jobs' },
  { key: 'callBacks', label: 'Call Backs' },
  { key: 'pendingCancellations', label: 'Pending Cancellations' },
];

export function buildTechWorkbook(data, filters, lookups, knockbackReasonsData, knockbackReasonsFilters) {
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
    ['Sales (invoices)', c.sales],
    // Trial (report logic only, no saved record is ever changed): Actual
    // Knockbacks and Conversion % are the same figures the old Knock backs /
    // Conversion rate rows used to show, renamed in place — see
    // services/reports.js for the calculation. Adjusted Knockbacks is the
    // only genuinely new figure.
    ['Converted Later', c.convertedLaterCredits],
    ['Actual Knockbacks', c.actualKnockbacks],
    ['Adjusted Knockbacks', c.adjustedKnockbacks],
    ['Conversion %', `${(c.bonusConversionRate ?? 0).toFixed(2)}%`],
    ['Total sale value (ex GST)', money(c.totalSaleExGst), CURRENCY_FORMAT],
    ['Average sale (ex GST)', money(c.avgSaleExGst), CURRENCY_FORMAT],
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
    { key: 'inspectionRate', label: 'Inspection Sheet %', value: (r) => `${r.inspectionRate}%` },
    { key: 'optionRate', label: 'Option Sheet %', value: (r) => `${r.optionRate}%` },
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
    { key: 'value', label: 'Value (ex GST)', value: (r) => money(r.value), numFmt: CURRENCY_FORMAT },
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
    { key: 'value', label: 'Value (ex GST)', value: (r) => money(r.value), numFmt: CURRENCY_FORMAT },
    { key: 'count', label: 'Sales count' },
  ], data.trend);

  // Knockback Reasons tracker — its own two sheets, driven entirely by that
  // box's own filters (knockbackReasonsFilters/knockbackReasonsData), never
  // the Technician & Sales report's filters above. Both sheets are built
  // from the exact same computeKnockbackReasonsReport() result, so their
  // totals can never drift apart from each other or from what the tracker
  // itself currently shows on screen.
  if (knockbackReasonsData) {
    const kf = knockbackReasonsFilters || {};
    const kbrExtra = [
      `Technician: ${kf.technicianId ? lookups?.technicians?.get(String(kf.technicianId)) || `#${kf.technicianId}` : 'All'}`,
      `Trade: ${kf.tradeId ? lookups?.trades?.get(String(kf.tradeId)) || `#${kf.tradeId}` : 'All'}`,
      `Reason: ${kf.reasonId ? lookups?.knockbackReasons?.get(String(kf.reasonId)) || `#${kf.reasonId}` : 'All'}`,
    ];
    const kbrFilterLines = filterSummaryLines({ from: kf.from, to: kf.to, extra: kbrExtra });

    const kbrSummary = wb.addWorksheet('Knockback Reasons Summary');
    addTitleBlock(kbrSummary, 'Knockback Reasons — Summary', kbrFilterLines);
    addDataTable(
      kbrSummary,
      [
        { key: 'name', label: 'Reason', width: 36 },
        { key: 'count', label: 'Count' },
        { key: 'percent', label: '% of knock-backs', value: (r) => `${r.percent}%` },
      ],
      knockbackReasonsData.byReason
    );
    kbrSummary.addRow([]);
    kbrSummary.addRow(['Total', knockbackReasonsData.total]);

    const kbrRecords = wb.addWorksheet('Knockback Records');
    addTitleBlock(kbrRecords, 'Knockback Reasons — Records', kbrFilterLines);
    addDataTable(
      kbrRecords,
      [
        { key: 'jobNumber', label: 'Job number', width: 18 },
        { key: 'visitDate', label: 'Date', width: 14 },
        { key: 'technicianName', label: 'Technician', width: 22 },
        { key: 'tradeName', label: 'Trade', width: 18 },
        { key: 'reasonName', label: 'Knockback reason', width: 32 },
      ],
      knockbackReasonsData.records
    );
  }

  return wb;
}
