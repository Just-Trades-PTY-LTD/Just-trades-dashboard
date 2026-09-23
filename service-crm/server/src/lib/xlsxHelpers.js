export const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A5C' } };
export const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
export const SECTION_FONT = { bold: true, size: 13 };

export function addTitleBlock(sheet, title, filterLines) {
  const titleRow = sheet.addRow([title]);
  titleRow.font = { bold: true, size: 15 };
  filterLines.forEach((line) => {
    sheet.addRow([line]).font = { italic: true, color: { argb: 'FF555555' } };
  });
  sheet.addRow([]);
}

export function addSectionHeading(sheet, text) {
  const row = sheet.addRow([text]);
  row.font = SECTION_FONT;
  sheet.addRow([]);
}

export function addDataTable(sheet, columns, rows) {
  const header = sheet.addRow(columns.map((c) => c.label));
  header.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  rows.forEach((row) => {
    sheet.addRow(columns.map((c) => (typeof c.value === 'function' ? c.value(row) : row[c.key])));
  });
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width || 16;
  });
}

export function filterSummaryLines({ from, to, extra = [] }) {
  const period = from || to ? `Period: ${from ? from : 'earliest'} – ${to ? to : 'latest'}` : 'Period: all dates';
  return [period, ...extra, `Generated: ${new Date().toLocaleString('en-AU')}`];
}
