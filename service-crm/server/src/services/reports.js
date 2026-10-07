import { all } from '../db/index.js';
import { mondayOf } from '../lib/adelaideTime.js';

export function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

// Inspection Sheet / Option Sheet completion rate: Yes ÷ (Yes + No), with
// "N/A" (the item genuinely didn't apply to that job) and any blank/legacy
// value (the question was never answered at all — every record saved
// before this field existed) excluded from BOTH sides, never counted as a
// silent "No". Neither should ever drag the rate down just for being
// recorded. Returns null — never 0 — when there are no Yes/No records to
// measure at all (all N/A, all blank, or no jobs), so the caller can show
// "—" instead of a misleading 0%.
function yesNoRate(yesCount, noCount) {
  const total = yesCount + noCount;
  return total ? Math.round((yesCount / total) * 100) : null;
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

// Stored dates are already Adelaide wall-clock calendar dates (see
// lib/adelaideTime.js) — "week" bucketing finds the Monday of that same
// calendar week via pure Y/M/D arithmetic, never a local-time Date getter,
// so it's correct no matter which timezone the server process itself runs
// in (this one runs in UTC).
function bucketKey(dateStr, granularity) {
  const d10 = dateStr.slice(0, 10);
  if (granularity === 'day') return d10;
  if (granularity === 'month') return dateStr.slice(0, 7);
  return mondayOf(d10);
}

// "8:00am – 8:59am" for hour 8, "12:00pm – 12:59pm" for hour 12 (noon),
// "12:00am – 12:59am" for hour 0 (midnight).
function formatHourRange(h) {
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${displayHour}:00${ampm} – ${displayHour}:59${ampm}`;
}

// Groups a calls array into hourly buckets by the hour embedded in call_at
// ("YYYY-MM-DDTHH:mm", already Adelaide wall-clock time — see
// lib/adelaideTime.js — so this is a direct read, not a timezone
// conversion). Only hours that actually have a record are included, sorted
// by hour, so an overnight/weekend chart doesn't imply a fixed business-hours
// window that isn't really there.
function countByHour(list) {
  const map = {};
  list.forEach((c) => {
    const hh = (c.call_at || '').slice(11, 13);
    if (hh.length !== 2) return;
    const h = Number(hh);
    if (Number.isNaN(h)) return;
    map[h] = (map[h] || 0) + 1;
  });
  return Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b)
    .map((h) => ({ hour: h, name: formatHourRange(h), value: map[h] }));
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

  // Separate from the by-date trend above — this shows volume by hour of
  // day (across the whole selected range), to spot the busiest calling
  // periods, not volume over the date range itself.
  const inboundByHour = countByHour(inboundCalls);

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

  return { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, inboundByHour, staffPerf };
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
  if (metric === 'inboundByHour') {
    const hh = String(category).padStart(2, '0');
    const inboundCalls = reportCalls.filter((c) => c.direction === 'Inbound');
    return {
      rows: inboundCalls.filter((c) => (c.call_at || '').slice(11, 13) === hh),
      label: `Inbound Calls by Time of Day — ${formatHourRange(Number(category))}`,
    };
  }

  return pickCallsSubset(reportCalls, metric);
}

// ---------------------------------------------------------------------------
// Technician & sales report
// ---------------------------------------------------------------------------
function fetchJobsAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT j.*, t.name AS technician_name, tr.name AS trade_name, kr.name AS knockback_reason_name
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN trades tr ON tr.id = j.trade_id
     LEFT JOIN list_items kr ON kr.id = j.knockback_reason_id
     WHERE j.archived = 0`
  );
  return rows.filter(
    (j) =>
      inRange(j.visit_date, from, to) &&
      (!technicianId || j.technician_id === Number(technicianId)) &&
      (!tradeId || j.trade_id === Number(tradeId))
  );
}

// Never includes an Existing Job — Upsell row (is_upsell=1) — an upsell
// deliberately shares its invoice number with the genuine original sale it
// adds to, and this function's own de-dup-by-invoice-number step below would
// otherwise treat the two as duplicates of each other and silently drop one
// (almost always the original sale, since the upsell is logged later and
// this keeps "the most recently logged one"). See fetchUpsellsAll() for the
// entirely separate population Upsells are counted from instead.
function fetchSalesAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     WHERE s.archived = 0 AND s.invoice_number != '' AND s.is_upsell = 0
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

// Existing Job — Upsell rows only. Deliberately never de-duplicated by
// invoice number the way fetchSalesAll() is above: an upsell legitimately
// shares its invoice with the original sale (that's the whole point), and
// two different technicians — or the same technician twice, on different
// occasions — can each add a distinct, genuine upsell onto that same
// invoice, so every row here counts, however many happen to share an
// invoice number.
function fetchUpsellsAll({ from, to, technicianId, tradeId }) {
  const rows = all(
    `SELECT s.*, t.name AS credited_technician_name, tr.name AS trade_name
     FROM sales s
     LEFT JOIN technicians t ON t.id = s.credited_technician_id
     LEFT JOIN trades tr ON tr.id = s.trade_id
     WHERE s.archived = 0 AND s.is_upsell = 1`
  );
  return rows.filter(
    (s) =>
      inRange(s.invoice_date, from, to) &&
      (!technicianId || s.credited_technician_id === Number(technicianId)) &&
      (!tradeId || s.trade_id === Number(tradeId))
  );
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
    upsellsAll: fetchUpsellsAll(filters),
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

// ---------------------------------------------------------------------------
// Converted Later bonus adjustment (trial) — report logic only.
//
// This is entirely separate from, and never reads or writes, the permanent
// job-level converted_later/converted_by_sale_id flip used elsewhere in this
// file (that flip is JN-based, has no week boundary and no per-technician
// cap, and permanently changes which bucket a job counts in for every
// report from then on). This adjustment instead computes a week-scoped,
// per-technician "bonus view" fresh from the raw jobs/sales on every report
// run — nothing it computes is stored, and removing it later is just
// deleting this code; no saved record is ever touched.
//
// Rule: each Converted Later sale (an 'quote_approved_later' sale, counted
// by its own invoice/approval date — never the original job's visit date)
// provides one credit against one genuine qualified-no-sale job (an "Actual
// Knockback", counted by its own visit date) for the same technician within
// the same Monday–Sunday week. Unused credits/unoffset knockbacks never
// cross a technician or week boundary in either direction.
function pctPrecise(a, b) {
  if (!b) return 0;
  const raw = (a / b) * 100;
  return Math.min(100, Math.max(0, Math.round(raw * 100) / 100));
}

// A genuine "Actual Knockback": a qualified job that didn't sell at the
// visit — regardless of whether it was ever later flipped by the separate,
// permanent converted_later mechanism, which this adjustment ignores
// entirely.
function genuineKnockbackJobs(jobs) {
  return jobs.filter((j) => j.lead === 'Qualified' && !j.had_sale_at_visit);
}

// Excludes Upsell rows defensively even though fetchSalesAll() already keeps
// them out of whatever `sales` array is normally passed in here — an Upsell
// is never Converted Later and must never contribute a credit, regardless of
// which array this is called with.
function quoteApprovedLaterSales(sales) {
  return sales.filter((s) => s.source === 'quote_approved_later' && !s.is_upsell);
}

// Buckets genuine qualified-no-sale jobs and quote-approved-later sales by
// (technician name, Monday-of-week) — the only two axes a credit is ever
// allowed to move across. `jobs`/`sales` should already carry any
// technician/trade/date filters the caller wants respected (this never
// re-fetches or re-filters on its own).
function bucketConvertedLaterCredits(jobs, sales) {
  const noSaleQualified = genuineKnockbackJobs(jobs);
  const quoteApprovedLater = quoteApprovedLaterSales(sales);

  const buckets = new Map();
  function bucket(techName, week) {
    const key = `${techName}\u0000${week}`;
    if (!buckets.has(key)) buckets.set(key, { techName, week, knockbackJobs: [], creditSales: [] });
    return buckets.get(key);
  }
  noSaleQualified.forEach((j) => {
    if (!j.visit_date) return;
    bucket(j.technician_name || 'Unassigned', mondayOf(j.visit_date)).knockbackJobs.push(j);
  });
  quoteApprovedLater.forEach((s) => {
    if (!s.invoice_date) return;
    bucket(s.credited_technician_name || 'Unassigned', mondayOf(s.invoice_date)).creditSales.push(s);
  });
  return buckets;
}

// One bucket's outcome: how many of its credits were actually consumed
// (deterministically, oldest invoice first, purely for a stable, explainable
// drill-down — the count is the same regardless of which specific credit is
// picked as "used"), and the resulting adjusted knockback count, floored at
// zero.
function bucketOutcome(b) {
  const actual = b.knockbackJobs.length;
  const credits = b.creditSales.length;
  const used = Math.min(actual, credits);
  const adjusted = Math.max(0, actual - credits);
  const sortedCredits = [...b.creditSales].sort((x, y) => (x.invoice_date || '').localeCompare(y.invoice_date || '') || x.id - y.id);
  return { actual, credits, used, adjusted, usedCredits: sortedCredits.slice(0, used), unusedCredits: sortedCredits.slice(used) };
}

// The four new, additive report figures — see the file-level comment above.
// `jobs`/`sales` are whatever set the caller wants this scoped to (the whole
// company, one technician, one trade, or a specific drill-down's already-
// filtered rows); the per-technician/per-week credit matching happens
// internally regardless of how broad or narrow that scope is.
//
// "Converted Later" is the count of credits actually APPLIED against an
// Actual Knockback (bucketOutcome's `used`) — never the raw count of
// Quote Approved Later sales in scope. A Quote Approved Later entry is also
// legitimately used to add an extra invoice to a job that already had a
// sale (see LogEntry.jsx) — that sale still counts fully in Sales/Value,
// but since there's no Actual Knockback left for it to offset that week, it
// must not inflate "Converted Later" or get subtracted a second time out of
// Adjusted Knockbacks. Using `used` here keeps the displayed "Converted
// Later" figure always consistent with Adjusted Knockbacks = Actual
// Knockbacks − Converted Later (never a mismatch where more credits show as
// "Converted Later" than were actually available to subtract).
function computeConvertedLaterAdjustment(jobs, sales) {
  const buckets = bucketConvertedLaterCredits(jobs, sales);
  let actualKnockbacks = 0;
  let convertedLaterCredits = 0;
  let adjustedKnockbacks = 0;
  buckets.forEach((b) => {
    const o = bucketOutcome(b);
    actualKnockbacks += o.actual;
    convertedLaterCredits += o.used;
    adjustedKnockbacks += o.adjusted;
  });
  const qualifiedCount = jobs.filter((j) => j.lead === 'Qualified').length;
  return {
    actualKnockbacks,
    convertedLaterCredits,
    adjustedKnockbacks,
    bonusConversionRate: pctPrecise(qualifiedCount - adjustedKnockbacks, qualifiedCount),
  };
}

// `upsells` defaults to [] so every existing caller (there were none before
// Upsell existed) keeps working unchanged; every figure below is exactly what
// it always was whenever there are no upsells in scope.
function computeMetrics(jobs, sales, callbacks, pendingCancels, upsells = []) {
  const { qualifiedJobs, unqualifiedJobs, saleMade, knockbacks, convertedLater } = splitJobs(jobs);
  const conversionCount = saleMade.length + convertedLater.length;
  // Original (non-upsell) sales only — this is what Sales (invoices) and
  // Average Sale are both still built from, so neither figure moves just
  // because a different technician upsold onto one of these invoices.
  const originalSaleExGst = sales.reduce((s, x) => s + num(x.sale_value_ex_gst), 0);
  const upsellValueExGst = upsells.reduce((s, x) => s + num(x.sale_value_ex_gst), 0);
  return {
    jobsAttended: jobs.length,
    qualifiedJobs: qualifiedJobs.length,
    unqualifiedJobs: unqualifiedJobs.length,
    knockbacks: knockbacks.length,
    knockbackRate: pct(knockbacks.length, qualifiedJobs.length),
    convertedLaterCount: convertedLater.length,
    conversionRate: pct(conversionCount, qualifiedJobs.length),
    // Sales (invoices) — unaffected by Upsells: an upsell is additional value
    // on an *existing* invoice, never a new one, so it's never counted here.
    sales: sales.length,
    // Value (ex GST) — the technician/trade's total credited revenue,
    // DELIBERATELY including Upsell value: real credited revenue, even
    // though it came from work on a job/invoice that isn't "theirs". See
    // avgSaleExGst below, which excludes it for exactly the opposite reason.
    totalSaleExGst: originalSaleExGst + upsellValueExGst,
    // Average Sale — original (non-upsell) sale value only, divided by
    // qualified jobs only (not total jobs, and not just the jobs that
    // resulted in a sale): a per-technician/per-trade productivity figure
    // scoped to genuine sales opportunities THIS technician/trade actually
    // had. Upsell value is deliberately excluded from the numerator here —
    // including it would inflate this average using revenue earned on a job
    // that was never one of these qualified jobs to begin with.
    avgSaleExGst: qualifiedJobs.length ? originalSaleExGst / qualifiedJobs.length : 0,
    // Upsells — shown as their own figures (see TechReport.jsx), never
    // folded into Sales (invoices) or Average Sale, and never treated as an
    // attended job or a qualified lead.
    upsellsCount: upsells.length,
    upsellValueExGst,
    callBacks: callbacks.length,
    pendingCancellations: pendingCancels.length,
    inspectionRate: yesNoRate(
      jobs.filter((j) => j.inspection_sheet === 'Yes').length,
      jobs.filter((j) => j.inspection_sheet === 'No').length
    ),
    optionRate: yesNoRate(
      jobs.filter((j) => j.option_sheet === 'Yes').length,
      jobs.filter((j) => j.option_sheet === 'No').length
    ),
  };
}

export function computeTechReport({ from, to, technicianId, tradeId, granularity = 'week' } = {}) {
  const filters = { from, to, technicianId, tradeId };
  const { jobsAll, salesAll, upsellsAll, callBacksAll, pendingCancelsAll } = fetchTechRaw(filters);

  const trades = all('SELECT * FROM trades ORDER BY sort_order');

  const company = {
    ...computeMetrics(jobsAll, salesAll, callBacksAll, pendingCancelsAll, upsellsAll),
    ...computeConvertedLaterAdjustment(jobsAll, salesAll),
  };

  const byTrade = trades.map((trade) => ({
    trade: trade.name,
    ...computeMetrics(
      jobsAll.filter((j) => j.trade_id === trade.id),
      salesAll.filter((s) => s.trade_id === trade.id),
      callBacksAll.filter((c) => c.trade_id === trade.id),
      pendingCancelsAll.filter((p) => p.trade_id === trade.id),
      upsellsAll.filter((u) => u.trade_id === trade.id)
    ),
  }));

  // The Technician (or Credited Technician) field is mandatory on every entry
  // type, so in ordinary use nothing should ever fall into this bucket — but
  // a record saved before that was enforced can still have a blank one. Such
  // a record must never be silently folded into a normal-looking "Unassigned"
  // row in the By Technician table (which would misleadingly read like a
  // real technician); instead it's counted here and surfaced separately (see
  // missingTechnicianCount / the 'missingTechnician' drill-down) so it can be
  // found and corrected at the source.
  const missingTechnicianCount =
    jobsAll.filter((j) => !j.technician_name).length +
    salesAll.filter((s) => !s.credited_technician_name).length +
    upsellsAll.filter((u) => !u.credited_technician_name).length +
    callBacksAll.filter((c) => !c.credited_technician_name).length +
    pendingCancelsAll.filter((p) => !p.credited_technician_name).length;

  const techNameSet = new Set();
  jobsAll.forEach((j) => j.technician_name && techNameSet.add(j.technician_name));
  salesAll.forEach((s) => s.credited_technician_name && techNameSet.add(s.credited_technician_name));
  // A technician whose only activity in range is an Upsell on someone else's
  // job (no job/sale/call back/pending cancellation of their own) must still
  // appear as their own row in By Technician, so their Upsells/Upsell Value
  // is visible rather than silently absent.
  upsellsAll.forEach((u) => u.credited_technician_name && techNameSet.add(u.credited_technician_name));
  callBacksAll.forEach((c) => c.credited_technician_name && techNameSet.add(c.credited_technician_name));
  pendingCancelsAll.forEach((p) => p.credited_technician_name && techNameSet.add(p.credited_technician_name));

  const byTechnician = Array.from(techNameSet).map((name) => {
    const techJobs = jobsAll.filter((j) => (j.technician_name || 'Unassigned') === name);
    // A Converted Later sale is scoped to whichever technician it's
    // credited to, not the job's own attending technician — usually the
    // same person, but an explicit override on that sale is respected here
    // exactly as it is everywhere else (see quote-approved-later's
    // creditedTechnicianId). An Upsell works the same way — scoped to
    // whichever technician actually made the upsell, never the original
    // job's own attending technician.
    const techSales = salesAll.filter((s) => (s.credited_technician_name || 'Unassigned') === name);
    const techUpsells = upsellsAll.filter((u) => (u.credited_technician_name || 'Unassigned') === name);
    return {
      name,
      ...computeMetrics(
        techJobs,
        techSales,
        callBacksAll.filter((c) => (c.credited_technician_name || 'Unassigned') === name),
        pendingCancelsAll.filter((p) => (p.credited_technician_name || 'Unassigned') === name),
        techUpsells
      ),
      ...computeConvertedLaterAdjustment(techJobs, techSales),
    };
  });

  // Upsell value is folded into each trade's total the same way it is into
  // each technician's own Value (ex GST) above — see computeMetrics().
  const salesByTradePie = trades
    .map((trade) => ({
      name: trade.name,
      value:
        salesAll.filter((s) => s.trade_id === trade.id).reduce((sum, s) => sum + num(s.sale_value_ex_gst), 0) +
        upsellsAll.filter((u) => u.trade_id === trade.id).reduce((sum, u) => sum + num(u.sale_value_ex_gst), 0),
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
  // Upsell value is added into the same period's value (consistent with
  // Value (ex GST) including it everywhere else), but never into `count` —
  // an upsell is never a new sale/invoice.
  upsellsAll.forEach((u) => {
    if (!u.invoice_date) return;
    const k = bucketKey(u.invoice_date, granularity);
    if (!trendMap[k]) trendMap[k] = { period: k, value: 0, count: 0 };
    trendMap[k].value += num(u.sale_value_ex_gst);
  });
  const trend = Object.values(trendMap).sort((a, b) => a.period.localeCompare(b.period));

  return { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend, missingTechnicianCount };
}

// A legacy job saved before Reason for Knockback was ever required — shown
// as this, never guessed at or left to silently vanish from the totals.
const NOT_RECORDED_REASON = 'Not recorded';

// ---------------------------------------------------------------------------
// Knockback Reasons tracker — its own report box, entirely independent of
// the Technician & Sales report's own filters (it carries its own from/to/
// technicianId/tradeId/reasonId, defaulting to the whole company with no
// date restriction). Scoped to the exact same "genuine Actual Knockback"
// population as the bonus-adjustment figures above (genuineKnockbackJobs) —
// a qualified job with no sale at the visit, regardless of whether it was
// ever later flipped by the separate, permanent converted_later mechanism
// (see that function's own comment). This is deliberate: the user asked that
// "the original knockback reason" stay attached to the original job "for
// historical reporting" even once its quote is approved later — the
// separate Converted Later sale is never itself a job and so can never
// appear here.
export function computeKnockbackReasonsReport({ from, to, technicianId, tradeId, reasonId } = {}) {
  const { jobsAll } = fetchTechRaw({ from, to, technicianId, tradeId });
  let knockbacks = genuineKnockbackJobs(jobsAll);
  if (reasonId) knockbacks = knockbacks.filter((j) => String(j.knockback_reason_id || '') === String(reasonId));

  const total = knockbacks.length;
  const counts = new Map();
  knockbacks.forEach((j) => {
    const name = j.knockback_reason_name || NOT_RECORDED_REASON;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  const byReason = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count, percent: pct(count, total) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // The exact original knock-back job records behind the figures above —
  // same population, same filters, so a consumer (e.g. the Excel export)
  // can never drift from what's displayed. Never a Quote Approved Later/
  // Converted Later row: genuineKnockbackJobs() only ever returns jobs.
  const records = knockbacks
    .map((j) => ({
      jobNumber: j.job_number,
      visitDate: j.visit_date,
      technicianName: j.technician_name || '',
      tradeName: j.trade_name || '',
      // "Not recorded" applies only to the knock-back reason itself (an
      // older job saved before it was required) — never guessed at here.
      reasonName: j.knockback_reason_name || NOT_RECORDED_REASON,
    }))
    .sort((a, b) => a.visitDate.localeCompare(b.visitDate) || a.jobNumber.localeCompare(b.jobNumber));

  return { total, byReason, records };
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

// Existing Job — Upsell rows are always their own entry kind (never folded
// into a job's own entry the way a sale-at-visit is) — see
// routes/techSales.js's saleToEntry().
function tagUpsells(list) {
  return list.map((u) => ({ kind: 'existing_job_upsell', id: u.id }));
}

// Selects the subset of (already date/technician/trade/scope-restricted)
// job/sale/callback/pending-cancellation arrays for one named figure —
// shared between the top-level KPI cards and the "By trade"/"By technician"
// table cells, which are the same figures further scoped to one row.
// Returns { rows: [{kind,id}], label, outcomes? } tagged by source table
// (jobs span two kinds depending on whether a sale was made at the visit),
// or null for an unrecognised field.
function pickTechSubset({ jobs, sales, callbacks, pendingCancels, upsells = [] }, field) {
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
    // Value (ex GST) includes Upsell value (see computeMetrics()), so its
    // drill-down shows both the original sales and the upsells that make it
    // up. Average Sale deliberately excludes Upsell value from its own
    // calculation, so its drill-down shows only the original sales it's
    // actually averaging.
    case 'totalSaleExGst':
      return { rows: [...tagSales(sales), ...tagUpsells(upsells)], label: 'Total sale value (ex GST)' };
    case 'avgSaleExGst':
      return { rows: tagSales(sales), label: 'Average sale (ex GST)' };
    case 'upsellsCount':
      return { rows: tagUpsells(upsells), label: 'Upsells' };
    case 'upsellValueExGst':
      return { rows: tagUpsells(upsells), label: 'Upsell value (ex GST)' };
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
    // --- Converted Later bonus adjustment (trial) — see the file-level
    // comment above computeConvertedLaterAdjustment(). Derived from the
    // exact same jobs/sales arrays already scoped by this drill-down's own
    // technician/trade filters, so these always match the displayed figure.
    //
    // Both figures below are built by bucketing jobs/sales the same way
    // computeConvertedLaterAdjustment() itself does (bucketConvertedLaterCredits),
    // rather than re-deriving the population a second, slightly different
    // way (e.g. genuineKnockbackJobs(jobs) directly) — a job missing a visit
    // date is silently skipped by the bucketer, so re-deriving independently
    // could show one more/fewer record than the figure it's meant to explain.
    // Bucketing first guarantees this drill-down's row count always equals
    // the displayed number, with no possibility of drift.
    case 'actualKnockbacks': {
      const buckets = bucketConvertedLaterCredits(jobs, sales);
      const knockbackJobs = [];
      buckets.forEach((b) => knockbackJobs.push(...b.knockbackJobs));
      return { rows: tagJobs(knockbackJobs), label: 'Actual Knockbacks' };
    }
    case 'convertedLaterCredits': {
      // Only the credits actually applied against an Actual Knockback — see
      // computeConvertedLaterAdjustment(). A Quote Approved Later sale that
      // had no knockback left to offset that week (e.g. a plain extra
      // invoice on an already-sold job) still counts in Sales/Value, but is
      // not "Converted Later" and so is excluded here too, keeping this
      // drill-down's total equal to the displayed figure.
      const buckets = bucketConvertedLaterCredits(jobs, sales);
      const usedCreditSales = [];
      buckets.forEach((b) => usedCreditSales.push(...bucketOutcome(b).usedCredits));
      return { rows: tagSales(usedCreditSales), label: 'Converted Later' };
    }
    // Adjusted Knockbacks (Actual Knockbacks − Converted Later) and
    // Conversion % (derived from Adjusted Knockbacks) are purely calculated
    // figures — neither represents its own distinct group of records, so
    // neither has a drill-down. Combining the Actual Knockback jobs and the
    // Converted Later sales into one list here previously produced a row
    // count equal to Actual + Converted Later (never Adjusted, their
    // difference), which was confusing and is why these two are excluded
    // instead of "fixed": there is no single accurate record set behind a
    // subtraction. Falls through to the default (no drill-down) below.
    case 'callBacks':
      return { rows: tagRows(callbacks, 'call_back'), label: 'Call backs' };
    case 'pendingCancellations':
      return { rows: tagRows(pendingCancels, 'pending_cancellation'), label: 'Pending cancellations' };
    // Records saved with no Technician/Credited Technician at all — the
    // Technician field is mandatory everywhere, so this should normally be
    // empty; it exists to surface a pre-existing legacy record for
    // correction rather than let it disappear into a misleading
    // "Unassigned" row in the By Technician table (see computeTechReport's
    // missingTechnicianCount).
    case 'missingTechnician':
      return {
        rows: [
          ...tagJobs(jobs.filter((j) => !j.technician_name)),
          ...tagSales(sales.filter((s) => !s.credited_technician_name)),
          ...tagUpsells(upsells.filter((u) => !u.credited_technician_name)),
          ...tagRows(callbacks.filter((c) => !c.credited_technician_name), 'call_back'),
          ...tagRows(pendingCancels.filter((p) => !p.credited_technician_name), 'pending_cancellation'),
        ],
        label: 'Records with no Technician assigned',
      };
    // N/A (and any blank/legacy "never answered") rows are excluded from the
    // rate itself (see yesNoRate() above), so they must also be excluded
    // here — the drill-down must only ever show the exact Yes/No records the
    // percentage was calculated from, never an N/A row sitting behind it
    // looking like a negative result it was never counted as.
    case 'inspectionRate': {
      const yesJobs = jobs.filter((j) => j.inspection_sheet === 'Yes');
      const noJobs = jobs.filter((j) => j.inspection_sheet === 'No');
      return {
        rows: tagJobs([...yesJobs, ...noJobs]),
        label: 'Inspection sheet completion',
        outcomes: [
          { label: 'Yes', count: yesJobs.length },
          { label: 'No', count: noJobs.length },
        ],
      };
    }
    case 'optionRate': {
      const yesJobs = jobs.filter((j) => j.option_sheet === 'Yes');
      const noJobs = jobs.filter((j) => j.option_sheet === 'No');
      return {
        rows: tagJobs([...yesJobs, ...noJobs]),
        label: 'Option sheet completion',
        outcomes: [
          { label: 'Yes', count: yesJobs.length },
          { label: 'No', count: noJobs.length },
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
  const { jobsAll, salesAll, upsellsAll, callBacksAll, pendingCancelsAll } = fetchTechRaw({ from, to, technicianId, tradeId });

  if (metric === 'salesByTradePie') {
    // This pie's own dollar value includes Upsell value for this trade (see
    // computeTechReport's salesByTradePie) — its drill-down shows both.
    return {
      rows: [...tagSales(salesAll.filter((s) => s.trade_name === category)), ...tagUpsells(upsellsAll.filter((u) => u.trade_name === category))],
      label: `Sale value by trade — ${category}`,
    };
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
  // The Knockback Reasons tracker's own drill-down — note this reads
  // technicianId/tradeId directly from the box's own filters above (already
  // applied by fetchTechRaw), never the Technician & Sales report's, since
  // the two sets of filters are entirely independent. `category` is the
  // clicked reason's exact display name, including "Not recorded".
  if (metric === 'knockbackByReason') {
    const knockbacks = genuineKnockbackJobs(jobsAll).filter((j) => (j.knockback_reason_name || NOT_RECORDED_REASON) === category);
    return { rows: knockbacks.map((j) => ({ kind: 'new_job_no_sale', id: j.id })), label: `Knockback reasons — ${category}` };
  }

  let jobs = jobsAll;
  let sales = salesAll;
  let upsells = upsellsAll;
  let callbacks = callBacksAll;
  let pendingCancels = pendingCancelsAll;
  let scopeLabel = '';
  if (scopeTrade) {
    jobs = jobs.filter((j) => j.trade_name === scopeTrade);
    sales = sales.filter((s) => s.trade_name === scopeTrade);
    upsells = upsells.filter((u) => u.trade_name === scopeTrade);
    callbacks = callbacks.filter((c) => c.trade_name === scopeTrade);
    pendingCancels = pendingCancels.filter((p) => p.trade_name === scopeTrade);
    scopeLabel = `${scopeTrade} — `;
  } else if (scopeTechnician) {
    jobs = jobs.filter((j) => (j.technician_name || 'Unassigned') === scopeTechnician);
    sales = sales.filter((s) => (s.credited_technician_name || 'Unassigned') === scopeTechnician);
    upsells = upsells.filter((u) => (u.credited_technician_name || 'Unassigned') === scopeTechnician);
    callbacks = callbacks.filter((c) => (c.credited_technician_name || 'Unassigned') === scopeTechnician);
    pendingCancels = pendingCancels.filter((p) => (p.credited_technician_name || 'Unassigned') === scopeTechnician);
    scopeLabel = `${scopeTechnician} — `;
  }

  const picked = pickTechSubset({ jobs, sales, callbacks, pendingCancels, upsells }, metric);
  if (!picked) return null;
  return { ...picked, label: `${scopeLabel}${picked.label}` };
}
