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

// A category value that's blank/null is grouped and displayed as "Not
// specified" everywhere in this file (KPI/chart breakdowns and drill-down
// alike) — this normalizes a raw field to that same label so a drill-down
// request for "Not specified" matches exactly what the chart/table showed.
function catLabel(v) {
  return v || 'Not specified';
}

// ---------------------------------------------------------------------------
// Calls report — one raw fetch, shared by the report's own KPIs/breakdowns
// and by drilldownCalls() below, so a figure and its drill-down can never
// drift apart from each other.
// ---------------------------------------------------------------------------
function fetchCallsRaw({ from, to, handledByUserId } = {}) {
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
  return rows.filter((c) => inRange(c.call_at, from, to) && (!handledByUserId || c.handled_by_user_id === Number(handledByUserId)));
}

export function computeCallsReport({ from, to, handledByUserId } = {}) {
  const reportCalls = fetchCallsRaw({ from, to, handledByUserId });

  const leads = reportCalls.filter((c) => c.call_type === 'Lead');
  const booked = leads.filter((c) => c.booked === 'Yes');

  // `direction` (the Contact Method) is NOT NULL at the DB level, and every
  // new call now requires picking one of the five options below before it
  // can be saved — so every call row should already carry one of these five
  // exact values. Rather than assume that, each method is counted by exact
  // match and total is left as reportCalls.length regardless of direction —
  // if a call ever had none of these five values (e.g. a pre-existing
  // record saved before Contact Method existed, or a future value this
  // report doesn't know about yet), the five counts would come up short of
  // total instead of quietly matching it, which is the visible signal that
  // something needs investigating rather than a silent miscount.
  const inboundCalls = reportCalls.filter((c) => c.direction === 'Inbound');
  const outboundCalls = reportCalls.filter((c) => c.direction === 'Outbound');
  const textMessages = reportCalls.filter((c) => c.direction === 'Text Message');
  const emails = reportCalls.filter((c) => c.direction === 'Email');
  const otherContacts = reportCalls.filter((c) => c.direction === 'Other / N/A');
  const quotesApproved = reportCalls.filter((c) => c.call_type === 'Quote approved');
  const callBackRequests = reportCalls.filter((c) => c.call_type === 'Call back');
  const newJobCancellations = reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'New Job Cancellation');
  const pendingCancellations = reportCalls.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'Pending Cancellation');

  const kpis = {
    total: reportCalls.length,
    inboundCount: inboundCalls.length,
    outboundCount: outboundCalls.length,
    textMessageCount: textMessages.length,
    emailCount: emails.length,
    otherContactCount: otherContacts.length,
    leadsCount: leads.length,
    bookedCount: booked.length,
    bookingRate: pct(booked.length, leads.length),
    quotesApproved: quotesApproved.length,
    callBackRequests: callBackRequests.length,
    newJobCancellations: newJobCancellations.length,
    pendingCancellations: pendingCancellations.length,
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
  const newCancelReasons = countBy(newJobCancellations, (c) => c.cancellation_reason_name);
  const pendingCancelReasons = countBy(pendingCancellations, (c) => c.cancellation_reason_name);

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
    if (!staffMap[k]) {
      staffMap[k] = { name: k, total: 0, inbound: 0, outbound: 0, textMessage: 0, email: 0, otherContact: 0, leads: 0, booked: 0 };
    }
    staffMap[k].total += 1;
    if (c.direction === 'Inbound') staffMap[k].inbound += 1;
    else if (c.direction === 'Outbound') staffMap[k].outbound += 1;
    else if (c.direction === 'Text Message') staffMap[k].textMessage += 1;
    else if (c.direction === 'Email') staffMap[k].email += 1;
    else if (c.direction === 'Other / N/A') staffMap[k].otherContact += 1;
    if (c.call_type === 'Lead') {
      staffMap[k].leads += 1;
      if (c.booked === 'Yes') staffMap[k].booked += 1;
    }
  });
  const staffPerf = Object.values(staffMap).map((s) => ({ ...s, rate: pct(s.booked, s.leads) }));

  return { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, staffPerf };
}

// Selects the subset of an (already date/staff-scoped) calls array for one
// named figure — shared between the top-level KPI cards and the "By staff"
// table's per-staff cells, which are the same figures further scoped to one
// staff member. Returns null for an unrecognised field so the caller can
// reject the request instead of silently returning nothing.
function pickCallsSubset(base, field) {
  const leads = base.filter((c) => c.call_type === 'Lead');
  const booked = leads.filter((c) => c.booked === 'Yes');
  switch (field) {
    case 'total':
      return { rows: base, label: 'Total Contacts' };
    case 'inbound':
      return { rows: base.filter((c) => c.direction === 'Inbound'), label: 'Inbound Calls' };
    case 'outbound':
      return { rows: base.filter((c) => c.direction === 'Outbound'), label: 'Outbound Calls' };
    case 'textMessage':
      return { rows: base.filter((c) => c.direction === 'Text Message'), label: 'Text Messages' };
    case 'email':
      return { rows: base.filter((c) => c.direction === 'Email'), label: 'Emails' };
    case 'otherContact':
      return { rows: base.filter((c) => c.direction === 'Other / N/A'), label: 'Other / N/A' };
    case 'leads':
      return { rows: leads, label: 'Leads' };
    case 'booked':
      return { rows: booked, label: 'Booked leads' };
    case 'bookingRate':
      return {
        rows: leads,
        label: 'Booking rate — Leads',
        outcomes: [
          { label: 'Booked', count: booked.length },
          { label: 'Not booked', count: leads.length - booked.length },
        ],
      };
    case 'quotesApproved':
      return { rows: base.filter((c) => c.call_type === 'Quote approved'), label: 'Quotes approved' };
    case 'callBackRequests':
      return { rows: base.filter((c) => c.call_type === 'Call back'), label: 'Call back requests' };
    case 'newJobCancellations':
      return {
        rows: base.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'New Job Cancellation'),
        label: 'New Job Cancellations',
      };
    case 'pendingCancellations':
      return {
        rows: base.filter((c) => c.call_type === 'Cancellation' && c.cancellation_type === 'Pending Cancellation'),
        label: 'Pending Cancellations',
      };
    default:
      return null;
  }
}

// Every clickable figure/chart section on the Calls & Contacts report,
// resolved against the exact same filtered rows the report itself computed
// its numbers from. Returns null for a metric this report has no accurate
// record-level answer for.
export function drilldownCalls({ from, to, handledByUserId, metric, category, segment, staffName, field }) {
  const reportCalls = fetchCallsRaw({ from, to, handledByUserId });
  const leads = reportCalls.filter((c) => c.call_type === 'Lead');

  if (metric === 'staff') {
    const base = reportCalls.filter((c) => (c.handled_by_name || 'Unassigned') === staffName);
    const picked = pickCallsSubset(base, field);
    if (!picked) return null;
    return { ...picked, label: `${staffName} — ${picked.label}` };
  }

  if (metric === 'byTrade') {
    return { rows: reportCalls.filter((c) => catLabel(c.trade_name) === category), label: `Calls by trade — ${category}` };
  }
  if (metric === 'bySource') {
    return { rows: leads.filter((c) => catLabel(c.lead_source_name) === category), label: `Leads by referral source — ${category}` };
  }
  if (metric === 'bySourceStack') {
    const wantBooked = segment === 'Booked';
    return {
      rows: leads.filter((c) => catLabel(c.lead_source_name) === category && (c.booked === 'Yes') === wantBooked),
      label: `${category} — ${segment}`,
    };
  }
  if (metric === 'notBookedReason') {
    return {
      rows: leads.filter((c) => c.booked === 'No' && catLabel(c.not_booked_reason_name) === category),
      label: `Why leads aren't booking — ${category}`,
    };
  }
  if (metric === 'newCancelReason') {
    return {
      rows: reportCalls.filter(
        (c) => c.call_type === 'Cancellation' && c.cancellation_type === 'New Job Cancellation' && catLabel(c.cancellation_reason_name) === category
      ),
      label: `New Job Cancellation reasons — ${category}`,
    };
  }
  if (metric === 'pendingCancelReason') {
    return {
      rows: reportCalls.filter(
        (c) => c.call_type === 'Cancellation' && c.cancellation_type === 'Pending Cancellation' && catLabel(c.cancellation_reason_name) === category
      ),
      label: `Pending Cancellation reasons — ${category}`,
    };
  }

  return pickCallsSubset(reportCalls, metric);
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

function fetchTechRaw(filters) {
  return {
    jobsAll: fetchJobsAll(filters),
    salesAll: fetchSalesAll(filters),
    callBacksAll: fetchCallBacksAll(filters),
    pendingCancelsAll: fetchPendingCancelsAll(filters),
  };
}

// Splits an (already scoped) jobs array into the buckets every job-based
// figure and drill-down is built from — a job with neither Qualified nor Not
// Qualified recorded (a legacy record only, since Lead is now required on
// every new "New Job" entry) is deliberately left out of both buckets rather
// than guessed into one.
function splitJobs(jobs) {
  const qualifiedJobs = jobs.filter((j) => j.lead === 'Qualified');
  const unqualifiedJobs = jobs.filter((j) => j.lead === 'Not Qualified');
  // Knock-back/converted-later/conversion are all scoped to qualified jobs
  // only — an unqualified job is never a knock-back and never counted as
  // "converted later", since it was never a genuine sales opportunity.
  const noSale = qualifiedJobs.filter((j) => !j.had_sale_at_visit);
  const saleMade = qualifiedJobs.filter((j) => j.had_sale_at_visit);
  const knockbacks = noSale.filter((j) => !j.converted_later);
  const convertedLater = noSale.filter((j) => j.converted_later);
  return { qualifiedJobs, unqualifiedJobs, noSale, saleMade, knockbacks, convertedLater };
}

function computeMetrics(jobs, sales, callbacks, pendingCancels) {
  const { qualifiedJobs, unqualifiedJobs, saleMade, knockbacks, convertedLater } = splitJobs(jobs);
  const conversionCount = saleMade.length + convertedLater.length;
  const totalSaleExGst = sales.reduce((s, x) => s + num(x.sale_value_ex_gst), 0);
  return {
    jobsAttended: jobs.length,
    qualifiedJobs: qualifiedJobs.length,
    unqualifiedJobs: unqualifiedJobs.length,
    knockbacks: knockbacks.length,
    knockbackRate: pct(knockbacks.length, qualifiedJobs.length),
    convertedLaterCount: convertedLater.length,
    conversionRate: pct(conversionCount, qualifiedJobs.length),
    sales: sales.length,
    totalSaleExGst,
    // Total sale value divided by qualified jobs only (not total jobs, and
    // not just the jobs that resulted in a sale) — a per-technician/
    // per-trade productivity figure scoped to genuine sales opportunities.
    avgSaleExGst: qualifiedJobs.length ? totalSaleExGst / qualifiedJobs.length : 0,
    callBacks: callbacks.length,
    pendingCancellations: pendingCancels.length,
    inspectionRate: pct(jobs.filter((j) => j.inspection_sheet === 'Yes').length, jobs.length),
    optionRate: pct(jobs.filter((j) => j.option_sheet === 'Yes').length, jobs.length),
  };
}

export function computeTechReport({ from, to, technicianId, tradeId, granularity = 'week' } = {}) {
  const filters = { from, to, technicianId, tradeId };
  const { jobsAll, salesAll, callBacksAll, pendingCancelsAll } = fetchTechRaw(filters);

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

function tagRows(list, kind) {
  return list.map((r) => ({ kind, id: r.id }));
}

// A "sale" is one row in the sales table, but it surfaces as two different
// kinds of entry in the Job History log depending on how it was made: a sale
// made at the original visit is folded into that visit's own Job entry
// (kind 'new_job_sale_made', identified by the JOB's id, not the sale row's
// own id) rather than listed separately, while a later "Quote Approved
// Later" sale is its own entry (kind 'quote_approved_later', by its own id).
function tagSales(list) {
  return list.map((s) => (s.source === 'sale_made_at_visit' ? { kind: 'new_job_sale_made', id: s.job_id } : { kind: 'quote_approved_later', id: s.id }));
}

// Selects the subset of (already date/technician/trade/scope-restricted)
// job/sale/callback/pending-cancellation arrays for one named figure —
// shared between the top-level KPI cards and the "By trade"/"By technician"
// table cells, which are the same figures further scoped to one row.
// Returns { rows: [{kind,id}], label, outcomes? } tagged by source table
// (jobs span two kinds depending on whether a sale was made at the visit),
// or null for an unrecognised field.
function pickTechSubset({ jobs, sales, callbacks, pendingCancels }, field) {
  const { qualifiedJobs, unqualifiedJobs, saleMade, knockbacks, convertedLater } = splitJobs(jobs);
  const jobKind = (j) => (j.had_sale_at_visit ? 'new_job_sale_made' : 'new_job_no_sale');
  const tagJobs = (list) => list.map((j) => ({ kind: jobKind(j), id: j.id }));

  switch (field) {
    case 'jobsAttended':
      return { rows: tagJobs(jobs), label: 'Total Jobs' };
    case 'qualifiedJobs':
      return { rows: tagJobs(qualifiedJobs), label: 'Qualified Jobs' };
    case 'unqualifiedJobs':
      return { rows: tagJobs(unqualifiedJobs), label: 'Unqualified Jobs' };
    case 'knockbacks':
      return { rows: tagJobs(knockbacks), label: 'Knock backs' };
    case 'convertedLaterCount':
      return { rows: tagJobs(convertedLater), label: 'Converted later' };
    case 'sales':
      return { rows: tagSales(sales), label: 'Sales (invoices)' };
    case 'totalSaleExGst':
      return { rows: tagSales(sales), label: 'Total sale value (ex GST)' };
    case 'avgSaleExGst':
      return { rows: tagSales(sales), label: 'Average sale (ex GST)' };
    case 'conversionRate':
      return {
        rows: tagJobs(qualifiedJobs),
        label: 'Conversion rate — Qualified Jobs',
        outcomes: [
          { label: 'Sale made', count: saleMade.length },
          { label: 'Converted later', count: convertedLater.length },
          { label: 'Knock back', count: knockbacks.length },
        ],
      };
    case 'callBacks':
      return { rows: tagRows(callbacks, 'call_back'), label: 'Call backs' };
    case 'pendingCancellations':
      return { rows: tagRows(pendingCancels, 'pending_cancellation'), label: 'Pending cancellations' };
    case 'inspectionRate': {
      const yes = jobs.filter((j) => j.inspection_sheet === 'Yes').length;
      return {
        rows: tagJobs(jobs),
        label: 'Inspection sheet completion',
        outcomes: [
          { label: 'Yes', count: yes },
          { label: 'No / not recorded', count: jobs.length - yes },
        ],
      };
    }
    case 'optionRate': {
      const yes = jobs.filter((j) => j.option_sheet === 'Yes').length;
      return {
        rows: tagJobs(jobs),
        label: 'Option sheet completion',
        outcomes: [
          { label: 'Yes', count: yes },
          { label: 'No / not recorded', count: jobs.length - yes },
        ],
      };
    }
    default:
      return null;
  }
}

// Every clickable figure/chart section on the Technician & Sales report,
// resolved against the exact same filtered rows the report itself computed
// its numbers from. `scopeTrade`/`scopeTechnician` narrow to one "By trade"/
// "By technician" table row, matching how that row's own figures are
// computed in computeTechReport() above. Returns null for a metric this
// report has no accurate record-level answer for.
export function drilldownTech({ from, to, technicianId, tradeId, metric, category, series, scopeTrade, scopeTechnician }) {
  const { jobsAll, salesAll, callBacksAll, pendingCancelsAll } = fetchTechRaw({ from, to, technicianId, tradeId });

  if (metric === 'salesByTradePie') {
    return { rows: tagSales(salesAll.filter((s) => s.trade_name === category)), label: `Sale value by trade — ${category}` };
  }
  if (metric === 'jobsOppSalesByTrade') {
    const jobKind = (j) => (j.had_sale_at_visit ? 'new_job_sale_made' : 'new_job_no_sale');
    if (series === 'Jobs') {
      const list = jobsAll.filter((j) => j.trade_name === category);
      return { rows: list.map((j) => ({ kind: jobKind(j), id: j.id })), label: `${category} — Jobs` };
    }
    if (series === 'Qualified leads') {
      const list = jobsAll.filter((j) => j.trade_name === category && j.lead === 'Qualified');
      return { rows: list.map((j) => ({ kind: jobKind(j), id: j.id })), label: `${category} — Qualified leads` };
    }
    return { rows: tagSales(salesAll.filter((s) => s.trade_name === category)), label: `${category} — Sales` };
  }

  let jobs = jobsAll;
  let sales = salesAll;
  let callbacks = callBacksAll;
  let pendingCancels = pendingCancelsAll;
  let scopeLabel = '';
  if (scopeTrade) {
    jobs = jobs.filter((j) => j.trade_name === scopeTrade);
    sales = sales.filter((s) => s.trade_name === scopeTrade);
    callbacks = callbacks.filter((c) => c.trade_name === scopeTrade);
    pendingCancels = pendingCancels.filter((p) => p.trade_name === scopeTrade);
    scopeLabel = `${scopeTrade} — `;
  } else if (scopeTechnician) {
    jobs = jobs.filter((j) => (j.technician_name || 'Unassigned') === scopeTechnician);
    sales = sales.filter((s) => (s.credited_technician_name || 'Unassigned') === scopeTechnician);
    callbacks = callbacks.filter((c) => (c.credited_technician_name || 'Unassigned') === scopeTechnician);
    pendingCancels = pendingCancels.filter((p) => (p.credited_technician_name || 'Unassigned') === scopeTechnician);
    scopeLabel = `${scopeTechnician} — `;
  }

  const picked = pickTechSubset({ jobs, sales, callbacks, pendingCancels }, metric);
  if (!picked) return null;
  return { ...picked, label: `${scopeLabel}${picked.label}` };
}
