// Admin AroFlo Test page only: works out, from the read-only probes in
// client.js's probeClientJobHistory(), what AroFlo can genuinely tell us
// about a customer's earlier jobs — and every reason the answer might not
// be reliable. Investigation output only: nothing here is used by any form,
// stored, or allowed to change a Lead Source.
//
// The `assessment` is deliberately conservative — an uncertain history is
// never guessed:
// - "repeat": AroFlo's customer filter is proven to have been applied, the
//   whole history was read (active and archived), the customer is one
//   individual at one site, and at least one EARLIER job was completed.
// - "no-earlier-completed-job": the same conditions, and no earlier job was
//   completed. This is NOT "definitely new" — a duplicate customer record,
//   or work done before AroFlo was used, can't be ruled out.
// - "uncertain": otherwise, with every reason listed.
//
// Privacy: only job numbers, statuses, types, dates, site ids and suburbs
// are passed on — never phone numbers, email addresses, street addresses or
// contact names, even if AroFlo returns them.

// What an earlier job actually was. Cancelled and quote-only jobs never count
// as completed work; an archived job only counts when AroFlo recorded a
// completion date (archiving alone doesn't prove the work was done).
export function jobOutcome(t) {
  const marker = `${t.substatus || ''} ${t.taskType || ''}`.toLowerCase();
  if (/cancel/.test(marker)) return 'cancelled';
  if (/quote/.test(marker)) return 'quote';
  const status = String(t.status || '').toUpperCase();
  if (status === 'COMPLETED' || t.completed) return 'completed';
  if (status === 'ARCHIVED') return 'archived (no completion date)';
  return 'unfinished';
}

export const ADDRESS_SAME = 'same address';
export const ADDRESS_DIFFERENT = 'different address';
export const ADDRESS_UNABLE = 'unable to compare';
const HOMEOWNER = /^(home\s*owner|owner|owner[\s-]*occupier|owner[\s-]*occupied)$/i;

// The names AroFlo uses for the customer's Lead Source field on this account
// (older records: "Lead/Referral Source").
export const LEAD_SOURCE_FIELD_NAMES = ['Lead Source', 'Lead/Referral Source'];
const isLeadSourceField = (name) => LEAD_SOURCE_FIELD_NAMES.some((n) => n.toLowerCase() === String(name || '').trim().toLowerCase());

// One address as comparable text: lower case, punctuation and spacing
// ignored, common abbreviations expanded (St/Street, Rd/Road…), "Unit"/"Lot"
// words and "Australia" dropped, "South Australia" read as SA. Never stored,
// never returned — only used to decide same / different.
const ABBREVIATIONS = {
  st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', pde: 'parade', dr: 'drive', ct: 'court', cres: 'crescent', cr: 'crescent',
  pl: 'place', tce: 'terrace', ln: 'lane', hwy: 'highway', blvd: 'boulevard', cl: 'close', gr: 'grove', cct: 'circuit', esp: 'esplanade',
  sq: 'square', nth: 'north', sth: 'south', mt: 'mount',
};
const DROP_WORDS = new Set(['unit', 'u', 'lot', 'flat', 'apartment', 'apt', 'australia']);
export function normalizeAddress(source) {
  let text = '';
  if (typeof source === 'string') text = source;
  else if (source && typeof source === 'object') {
    text = source.locationText || [source.location?.address1, source.location?.address2, source.location?.suburb, source.location?.state, source.location?.postCode].filter(Boolean).join(' ');
  }
  const words = String(text || '')
    .toLowerCase()
    .replace(/south\s+australia/g, ' sa ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !DROP_WORDS.has(w))
    .map((w) => ABBREVIATIONS[w] || w);
  return words.join(' ');
}

export function compareAddresses(a, b) {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  if (!x || !y || !/\d/.test(x) || !/\d/.test(y)) return ADDRESS_UNABLE;
  return x === y ? ADDRESS_SAME : ADDRESS_DIFFERENT;
}

const itemsOf = (probe) => (probe?.available ? probe.data?.items || [] : []);

function slimTask(t) {
  const slim = {
    id: t.id,
    jobNumber: t.jobNumber ?? null,
    status: t.status || '',
    substatus: t.substatus?.name || '',
    taskType: t.taskType?.name || '',
    created: t.timestampCreated || null,
    requested: t.requestedDateTime || null,
    completed: t.completionDate || null,
    siteId: t.location?.id || null,
    suburb: t.location?.suburb || null,
    clientId: t.client?.id || null,
  };
  return { ...slim, outcome: jobOutcome(slim) };
}

const earlierDate = (a, b) => (a && b ? String(a) < String(b) : null);

// Was a filter really applied? An ignored query parameter would return other
// customers' (or other sites') jobs, or leave the current job out.
function filterCheck(probe, items, field, value, currentId, what) {
  if (!probe) return { honoured: null, reason: null };
  if (!probe.available) return { honoured: null, reason: `AroFlo refused the job list filtered by ${what} (HTTP ${probe.status || '—'}).` };
  const foreign = items.filter((t) => t[field] && t[field] !== value);
  if (foreign.length) return { honoured: false, reason: `AroFlo returned ${foreign.length} job(s) for a different ${what} — the ${what} filter was not applied.` };
  if (!probe.truncated && !items.some((t) => t.id === currentId)) {
    return { honoured: false, reason: `The current job itself wasn't in the ${what}'s job list, so that list can't be trusted.` };
  }
  return { honoured: true, reason: null };
}

export function analyzeClientHistory({ currentTask, clientDetail, probes, sameNameClients, addressChecks = null, occupant = null }) {
  const clientId = currentTask?.client?.id || null;
  const client = clientDetail?.available ? clientDetail.data || {} : {};
  if (!clientId) {
    return { clientId: null, assessment: 'uncertain', reasons: ['This AroFlo job has no customer (client) attached.'] };
  }
  const reasons = [];
  const current = slimTask(currentTask);
  const defaultItems = itemsOf(probes?.defaultList).map(slimTask);
  const archivedItems = itemsOf(probes?.archivedList).map(slimTask);
  const siteItems = itemsOf(probes?.siteList).map(slimTask);
  const siteCount = itemsOf(probes?.locations).length;

  // 1. Were the customer and site filters actually applied?
  const customerFilter = filterCheck(probes?.defaultList, defaultItems, 'clientId', clientId, current.id, 'customer');
  if (customerFilter.reason) reasons.push(customerFilter.reason);
  const siteFilter = current.siteId ? filterCheck(probes?.siteList, siteItems, 'siteId', current.siteId, current.id, 'site') : { honoured: null, reason: null };
  if (siteFilter.reason) reasons.push(siteFilter.reason);

  // 2. Active and archived history, every page.
  if (probes?.archivedList && !probes.archivedList.available) reasons.push("Archived jobs couldn't be checked.");
  const defaultIds = new Set(defaultItems.map((t) => t.id));
  const archivedIncludedByDefault = probes?.archivedList?.available && archivedItems.length ? archivedItems.every((t) => defaultIds.has(t.id)) : null;
  const truncated = [probes?.defaultList, probes?.archivedList, probes?.siteList].some((p) => p?.truncated);
  if (truncated) reasons.push('More jobs exist than were read (over the page limit) — the history is incomplete.');

  // Every job of this customer, once, oldest job number first.
  const byId = new Map();
  [...defaultItems, ...archivedItems].forEach((t) => byId.set(t.id, t));
  const jobs = [...byId.values()].sort((a, b) => Number(a.jobNumber) - Number(b.jobNumber));
  const others = jobs.filter((t) => t.id !== current.id);

  // 3. Earlier = a lower job number (AroFlo numbers jobs in sequence); dates
  // are compared too, and any disagreement is reported rather than resolved.
  const earlier = others.filter((t) => Number(t.jobNumber) < Number(current.jobNumber));
  const dateDisagreements = others.filter((t) => {
    const byDate = earlierDate(t.created || t.requested, current.created || current.requested);
    return byDate !== null && byDate !== Number(t.jobNumber) < Number(current.jobNumber);
  });
  if (dateDisagreements.length) reasons.push(`${dateDisagreements.length} job(s) are ordered differently by job number and by created date.`);
  // Same property? Each earlier job's address compared with this job's
  // (normalised, privacy-safe: only the outcome is ever kept). Without a
  // linked AroFlo site this is the only way to tell, so any earlier job at a
  // different address, or one that couldn't be compared, keeps it uncertain.
  earlier.forEach((t) => {
    t.address = addressChecks ? addressChecks.get(t.id) || ADDRESS_UNABLE : null;
  });
  if (addressChecks) {
    const different = earlier.filter((t) => t.address === ADDRESS_DIFFERENT).length;
    const unable = earlier.filter((t) => t.address === ADDRESS_UNABLE).length;
    if (different) reasons.push(`${different} earlier job(s) were at a different address — possibly another property.`);
    if (unable) reasons.push(`The address of ${unable} earlier job(s) couldn't be compared, so it can't be confirmed they were at the same property.`);
  } else if (!current.siteId && earlier.length && siteCount !== 1) {
    reasons.push("This job has no linked AroFlo site record and the earlier jobs' addresses weren't compared, so it can't be confirmed they were at the same property.");
  }
  const earlierCompleted = earlier.filter((t) => t.outcome === 'completed');
  const earlierCompletedSameSite = current.siteId ? earlierCompleted.filter((t) => t.siteId === current.siteId) : [];
  const earlierCompletedSameAddress = earlierCompleted.filter((t) => t.address === ADDRESS_SAME);

  // 4. When "same customer record" is a weak sign of "same person, same property".
  if (client.individual === false) reasons.push('The AroFlo customer is an organisation (e.g. an agency, builder, landlord or business), not an individual — its jobs may be for different people or properties.');
  if (client.individual === undefined || client.individual === null) reasons.push("AroFlo didn't say whether this customer is an individual or an organisation.");
  if (client.parent?.id) reasons.push('The customer sits under a parent customer account.');
  const siteIds = new Set(jobs.map((t) => t.siteId).filter(Boolean));
  const sites = Math.max(siteIds.size, siteCount);
  if (sites > 1) reasons.push(`The customer has ${sites} sites/properties — earlier jobs may be at a different property.`);
  const sameName = sameNameClients?.available ? (sameNameClients.data?.items || []).filter((c) => c.id !== clientId).length : null;
  if (sameName) reasons.push(`${sameName} other AroFlo customer record(s) have exactly the same name — possible duplicate records, so earlier jobs may sit under another record.`);
  if (sameNameClients && !sameNameClients.available) {
    reasons.push(`Couldn't check AroFlo for other customer records with the same name (AroFlo ${sameNameClients.status ? `HTTP ${sameNameClients.status}` : 'no response'}${sameNameClients.errorText ? `: ${sameNameClients.errorText}` : ''}).`);
  }
  if (occupant && !HOMEOWNER.test(String(occupant).trim())) {
    reasons.push(`AroFlo records the occupant as "${occupant}", not the homeowner (e.g. a tenant, landlord or property manager) — earlier jobs may relate to someone else.`);
  }

  const reliable = customerFilter.honoured === true && siteFilter.honoured !== false && !truncated && probes?.archivedList?.available !== false && reasons.length === 0;
  let assessment = 'uncertain';
  if (reliable && earlierCompleted.length) assessment = 'repeat';
  else if (reliable) assessment = 'no-earlier-completed-job';

  return {
    clientId,
    clientName: client.name || currentTask.client?.name || null,
    individual: client.individual ?? null,
    hasParent: !!client.parent?.id,
    sites,
    sameNameCustomerRecords: sameName,
    customerFilterHonoured: customerFilter.honoured,
    siteFilterHonoured: siteFilter.honoured,
    archivedIncludedByDefault,
    pagesRead: {
      customer: probes?.defaultList?.pagesFetched ?? null,
      archived: probes?.archivedList?.pagesFetched ?? null,
      site: probes?.siteList?.pagesFetched ?? null,
    },
    totals: {
      customerJobs: probes?.defaultList?.available ? probes.defaultList.data?.count ?? defaultItems.length : null,
      archivedJobs: probes?.archivedList?.available ? probes.archivedList.data?.count ?? archivedItems.length : null,
      siteJobs: probes?.siteList?.available ? probes.siteList.data?.count ?? siteItems.length : null,
    },
    truncated,
    currentJob: current,
    earlierJobs: earlier,
    earlierCompletedCount: earlierCompleted.length,
    earlierCompletedAtThisSite: earlierCompletedSameSite.length,
    earlierCompletedAtSameAddress: addressChecks ? earlierCompletedSameAddress.length : null,
    occupant: occupant || null,
    // Structured flags for the call form's Lead Source decision.
    sameNameCheckFailed: !!(sameNameClients && !sameNameClients.available),
    archivedChecked: probes?.archivedList?.available !== false,
    completedOrderingConflicts: dateDisagreements.filter((t) => t.outcome === 'completed').length,
    laterJobs: others.filter((t) => !earlier.includes(t)),
    assessment,
    assessmentLabel: {
      repeat: 'Repeat customer — an earlier completed job was found',
      'no-earlier-completed-job': 'No earlier completed job found (this does not prove the customer is new)',
      uncertain: 'Uncertain — leave Lead Source for staff',
    }[assessment],
    reasons,
  };
}

// Custom fields for a zone, as { zone, available, fields: [{ name, value }] }
// — any email address or phone number inside a value is masked.
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE = /(?:\+?61|0)[\s-]?\d(?:[\s-]?\d){7,9}/g;
export function maskContactDetails(value) {
  if (value === null || value === undefined) return value;
  return String(value).replace(EMAIL, '[email hidden]').replace(PHONE, '[phone hidden]');
}

export function summarizeCustomFields(probe, zone) {
  if (!probe) return null;
  if (!probe.available) return { zone, available: false, status: probe.status || null, fields: [] };
  const fields = [];
  for (const item of probe.data?.items || []) {
    const entries = Array.isArray(item.fields) ? item.fields : [item];
    for (const e of entries) {
      const name = e.customField?.name ?? e.name;
      if (!name) continue;
      fields.push({ name, value: maskContactDetails(e.customField?.value ?? e.value ?? null) });
    }
  }
  const lead = fields.find((f) => isLeadSourceField(f.name) && f.value);
  return {
    zone,
    available: true,
    fields,
    leadSource: lead?.value ?? null,
    leadSourceField: lead?.name ?? null,
    occupant: fields.find((f) => /^occupant$/i.test(String(f.name).trim()))?.value ?? null,
  };
}
