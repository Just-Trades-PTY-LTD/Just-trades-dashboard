import { adelaideGeneratedAtLabel } from './adelaideTime.js';

export const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A5C' } };
export const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
export const SECTION_FONT = { bold: true, size: 13 };

// Every monetary export column/cell uses this one format, so a cell always
// displays standard-rounded to 2 decimal places (e.g. $374.00, $579.70) —
// never a long raw float, never truncated whole dollars. Purely a display
// mask: the cell's actual stored number (see money() below) is unaffected,
// so it stays exact to the cent for any formula built on top of it.
export const CURRENCY_FORMAT = '"$"#,##0.00';

// Rounds to the nearest cent and returns a plain Number (never text), so the
// exported cell is a real number Excel can sum/average — never currency
// formatted as a string. Only ever applied at this final "build the export
// cell" step; the report calculation this value came from (reports.js) still
// runs at full floating-point precision beforehand, untouched by this.
export function money(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

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

// A column with `numFmt` (e.g. CURRENCY_FORMAT) gets that display format on
// every data cell underneath it — never the header row, and never the
// cell's underlying value, which is whatever `value`/row[key] produced.
export function addDataTable(sheet, columns, rows) {
  const header = sheet.addRow(columns.map((c) => c.label));
  header.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
  });
  rows.forEach((row) => {
    const dataRow = sheet.addRow(columns.map((c) => (typeof c.value === 'function' ? c.value(row) : row[c.key])));
    columns.forEach((c, i) => {
      if (c.numFmt) dataRow.getCell(i + 1).numFmt = c.numFmt;
    });
  });
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width || 16;
  });
}

export function filterSummaryLines({ from, to, extra = [] }) {
  const period = from || to ? `Period: ${from ? from : 'earliest'} – ${to ? to : 'latest'}` : 'Period: all dates';
  return [period, ...extra, `Generated: ${adelaideGeneratedAtLabel()}`];
}
