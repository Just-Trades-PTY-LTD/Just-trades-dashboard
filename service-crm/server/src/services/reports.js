import { all } from '../db/index.js';

export function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

export function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function countBy(list, keyFn) {
  const map = {};
  list.forEach((item) => {
    const k = keyFn(item) || 'Not specified';
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function inRange(dateStr, from, to) {
  if (!from && !to) return true;
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function bucketKey(dateStr, granularity) {
  const d10 = dateStr.slice(0, 10);
  if (granularity === 'day') return d10;
  if (granularity === 'month') return dateStr.slice(0, 7);
  const d = new Date(d10);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Calls report
// ---------------------------------------------------------------------------
export function computeCallsReport({ from, to, handledByUserId } = {}) {
  const rows = all(
    `SELECT c.*, u.name AS handled_by_name, tr.name AS trade_name, ls.name AS lead_source_name,
      nbr.name AS not_booked_reason_name, cr.name AS cancellation_reason_name
     FROM calls c
     LEFT JOIN users u ON u.id = c.handled_by_user_id
     LEFT JOIN trades tr ON tr.id = c.trade_id
     LEFT JOIN list_items ls ON ls.id = c.lead_source_id
     LEFT JOIN list_items nbr ON nbr.id = c.not_booked_reason_id
     LEFT JOIN list_items cr ON cr.id = c.cancellation_reason_id
     WHERE c.archived = 0`
  );

  const reportCalls = rows.filter((c) => inRange(c.call_at, from, to) && (!handledByUserId || c.handled_by_user_id === Number(handledByUserId)));

  const leads = reportCalls.filter((c) => c.call_type === 'Lead');
  const booked = leads.filter((c) => c.booked === 'Yes');

  const kpis = {
    total: reportCalls.length,
    leadsCount: leads.length,
    bookedCount: booked.length,
    bookingRate: pct(booked.length, leads.length),
    quotesApproved: reportCalls.filter((c) => c.call_type === 'Quote approved').length,
    callBackRequests: reportCalls.filter((c) => c.call_type === 'Call back').length,
    newJobCancellations: reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'New Job Cancellation').length,
    pendingCancellations: reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'Pending Cancellation').length,
  };

  const byTrade = countBy(reportCalls.filter((c) => c.trade_name), (c) => c.trade_name);
  const bySourcePie = countBy(leads.filter((c) => c.lead_source_name), (c) => c.lead_source_name);

  const stackMap = {};
  leads.filter((c) => c.lead_source_name).forEach((c) => {
    if (!stackMap[c.lead_source_name]) stackMap[c.lead_source_name] = { name: c.lead_source_name, Booked: 0, 'Not booked': 0 };
    if (c.booked === 'Yes') stackMap[c.lead_source_name].Booked += 1;
    else stackMap[c.lead_source_name]['Not booked'] += 1;
  });
  const bySourceStack = Object.values(stackMap);

  const notBookedReasons = countBy(leads.filter((c) => c.booked === 'No'), (c) => c.not_booked_reason_name);
  const newCancelReasons = countBy(
    reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'New Job Cancellation'),
    (c) => c.cancellation_reason_name
  );
  const pendingCancelReasons = countBy(
    reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'Pending Cancellation'),
    (c) => c.cancellation_reason_name
  );

  const trendMap = {};
  reportCalls.forEach((c) => {
    const d = (c.call_at || '').slice(0, 10);
    if (d) trendMap[d] = (trendMap[d] || 0) + 1;
  });
  const trend = Object.entries(trendMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  const staffMap = {};
  reportCalls.forEach((c) => {
    const k = c.handled_by_name || 'Unassigned';
    if (!staffMap[k]) staffMap[k] = { name: k, total: 0, leads: 0, booked: 0 };
    staffMap[k].total += 1;
    if (c.call_type === 'Lead') {
      staffMap[k].leads += 1;
      if (c.booked === 'Yes') staffMap[k].booked += 1;
    }
  });
  const staffPerf = Object.values(staffMap).map((s) => ({ ...s, rate: pct(s.booked, s.leads) }));

  return { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, staffPerf };
}

// ---------------------------------------------------------------------------
// Technician & sales report
// ---------------------------------------------------------------------------
function fetchJobsAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT j.*, t.name AS technician_name, tr.name AS trade_name
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN trades tr ON tr.id = j.trade_id
     WHERE j.archived = 0`
  );
  return rows.filter(
    (j) =>
      inRange(j.visit_date, from, to) &&
      (!technicianId || j.technician_id === Number(technicianId)) &&
      (!tradeId || j.trade_id === Number(tradeId))
  );
}

function fetchSalesAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     WHERE s.archived = 0 AND s.invoice_number != ''
     ORDER BY s.id DESC`
  );
  const filtered = rows.filter(
    (s) =>
      inRange(s.invoice_date, from, to) &&
      (!technicianId || s.credited_technician_id === Number(technicianId)) &&
      (!tradeId || s.trade_id === Number(tradeId))
  );
  // De-duplicate by invoice number — a duplicate is only ever counted once in
  // reports (HANDOVER §5.3), keeping the most recently logged one.
  const seen = new Set();
  const out = [];
  filtered.forEach((s) => {
    const key = (s.invoice_number || '').trim().toLowerCase();
    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      out.push(s);
    }
  });
  return out;
}

function fetchCallBacksAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT cb.*, ct.name AS credited_technician_name, tr.name AS trade_name
     FROM call_backs cb
     LEFT JOIN technicians ct ON ct.id = cb.credited_technician_id
     LEFT JOIN trades tr ON tr.id = cb.trade_id
     WHERE cb.archived = 0`
  );
  return rows.filter(
    (c) =>
      inRange(c.visit_date, from, to) &&
      (!technicianId || c.credited_technician_id === Number(technicianId)) &&
      (!tradeId || c.trade_id === Number(tradeId))
  );
}

function fetchPendingCancelsAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT pc.*, t.name AS credited_technician_name, tr.name AS trade_name
     FROM pending_cancellations pc
     LEFT JOIN technicians t ON t.id = pc.credited_technician_id
     LEFT JOIN trades tr ON tr.id = pc.trade_id
     WHERE pc.archived = 0`
  );
  return rows.filter(
    (p) =>
      inRange(p.date_logged, from, to) &&
      (!technicianId || p.credited_technician_id === Number(technicianId)) &&
      (!tradeId || p.trade_id === Number(tradeId))
  );
}

function computeMetrics(jobs, sales, callbacks, pendingCancels) {
  const noSale = jobs.filter((j) => !j.had_sale_at_visit);
  const saleMade = jobs.filter((j) => j.had_sale_at_visit);
  const knockbacks = noSale.filter((j) => !j.converted_later);
  const convertedLater = noSale.filter((j) => j.converted_later);
  const conversionCount = saleMade.length + convertedLater.length;
  const totalSaleExGst = sales.reduce((s, x) => s + num(x.sale_value_ex_gst), 0);
  return {
    jobsAttended: jobs.length,
    qualifiedLeads: jobs.filter((j) => j.lead === 'Qualified').length,
    knockbacks: knockbacks.length,
    knockbackRate: pct(knockbacks.length, jobs.length),
    convertedLaterCount: convertedLater.length,
    conversionRate: pct(conversionCount, jobs.length),
    sales: sales.length,
    totalSaleExGst,
    avgSaleExGst: sales.length ? Math.round(totalSaleExGst / sales.length) : 0,
    callBacks: callbacks.length,
    pendingCancellations: pendingCancels.length,
    inspectionRate: pct(jobs.filter((j) => j.inspection_sheet === 'Yes').length, jobs.length),
    optionRate: pct(jobs.filter((j) => j.option_sheet === 'Yes').length, jobs.length),
  };
}

export function computeTechReport({ from, to, technicianId, tradeId, granularity = 'week' } = {}) {
  const filters = { from, to, technicianId, tradeId };
  const jobsAll = fetchJobsAll(filters);
  const salesAll = fetchSalesAll(filters);
  const callBacksAll = fetchCallBacksAll(filters);
  const pendingCancelsAll = fetchPendingCancelsAll(filters);

  const trades = all('SELECT * FROM trades ORDER BY sort_order');

  const company = computeMetrics(jobsAll, salesAll, callBacksAll, pendingCancelsAll);

  const byTrade = trades.map((trade) => ({
    trade: trade.name,
    ...computeMetrics(
      jobsAll.filter((j) => j.trade_id === trade.id),
      salesAll.filter((s) => s.trade_id === trade.id),
      callBacksAll.filter((c) => c.trade_id === trade.id),
      pendingCancelsAll.filter((p) => p.trade_id === trade.id)
    ),
  }));

  const techNameSet = new Set();
  jobsAll.forEach((j) => techNameSet.add(j.technician_name || 'Unassigned'));
  salesAll.forEach((s) => techNameSet.add(s.credited_technician_name || 'Unassigned'));
  callBacksAll.forEach((c) => techNameSet.add(c.credited_technician_name || 'Unassigned'));
  pendingCancelsAll.forEach((p) => techNameSet.add(p.credited_technician_name || 'Unassigned'));

  const byTechnician = Array.from(techNameSet).map((name) => ({
    name,
    ...computeMetrics(
      jobsAll.filter((j) => (j.technician_name || 'Unassigned') === name),
      salesAll.filter((s) => (s.credited_technician_name || 'Unassigned') === name),
      callBacksAll.filter((c) => (c.credited_technician_name || 'Unassigned') === name),
      pendingCancelsAll.filter((p) => (p.credited_technician_name || 'Unassigned') === name)
    ),
  }));

  const salesByTradePie = trades
    .map((trade) => ({
      name: trade.name,
      value: salesAll.filter((s) => s.trade_id === trade.id).reduce((sum, s) => sum + num(s.sale_value_ex_gst), 0),
    }))
    .filter((d) => d.value > 0);

  const jobsOppSalesByTrade = trades.map((trade) => ({
    name: trade.name,
    Jobs: jobsAll.filter((j) => j.trade_id === trade.id).length,
    'Qualified leads': jobsAll.filter((j) => j.trade_id === trade.id && j.lead === 'Qualified').length,
    Sales: salesAll.filter((s) => s.trade_id === trade.id).length,
  }));

  const trendMap = {};
  salesAll.forEach((s) => {
    if (!s.invoice_date) return;
    const k = bucketKey(s.invoice_date, granularity);
    if (!trendMap[k]) trendMap[k] = { period: k, value: 0, count: 0 };
    trendMap[k].value += num(s.sale_value_ex_gst);
    trendMap[k].count += 1;
  });
  const trend = Object.values(trendMap).sort((a, b) => a.period.localeCompare(b.period));

  return { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend };
}
