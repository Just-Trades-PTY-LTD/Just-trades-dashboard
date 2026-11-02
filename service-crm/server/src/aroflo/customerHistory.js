// Admin AroFlo Test page only: works out, from the read-only probes in
// client.js's probeClientJobHistory(), what AroFlo can genuinely tell us
// about a customer's earlier jobs — and every reason the answer might not
// be reliable. Investigation output only: nothing here is used by any form,
// stored, or allowed to change a Lead Source.
//
// The `assessment` is deliberately conservative, matching the agreed rule
// that an uncertain history must never be guessed:
// - "repeat"    only when AroFlo's client filter is proven to work, the
//               whole history was read, the customer is a single individual
//               at one site, and at least one EARLIER job was completed.
// - "new"       only under the same conditions with no earlier job at all.
// - "uncertain" otherwise, with the reasons listed.

const COMPLETED = new Set(['COMPLETED', 'ARCHIVED']);

function itemsOf(probe) {
  return probe?.available ? probe.data?.items || [] : [];
}

function totalOf(probe) {
  if (!probe?.available) return null;
  const n = Number(probe.data?.count);
  return Number.isFinite(n) ? n : null;
}

// Only what the investigation needs to show — never site contacts, phone
// numbers or rates, even when AroFlo returns them.
function slimTask(t) {
  return {
    id: t.id,
    jobNumber: t.jobNumber ?? null,
    status: t.status || '',
    taskType: t.taskType?.name || '',
    requested: t.requestedDateTime || null,
    created: t.timestampCreated || null,
    completed: t.completionDate || null,
    locationId: t.location?.id || null,
    suburb: t.location?.suburb || null,
    clientId: t.client?.id || null,
  };
}

const earlierDate = (a, b) => (a && b ? String(a) < String(b) : null);

export function analyzeClientHistory({ currentTask, clientDetail, probes }) {
  const clientId = currentTask?.client?.id || null;
  const client = clientDetail?.available ? clientDetail.data || {} : {};
  const reasons = [];
  if (!clientId) {
    return { clientId: null, assessment: 'uncertain', reasons: ['This AroFlo job has no customer (client) attached.'] };
  }

  const defaultItems = itemsOf(probes?.defaultList).map(slimTask);
  const archivedItems = itemsOf(probes?.archivedList).map(slimTask);
  const locationItems = itemsOf(probes?.locations);

  // Was the clientId filter actually applied? An ignored query parameter
  // would return other customers' jobs.
  const all = [...defaultItems, ...archivedItems];
  const foreign = all.filter((t) => t.clientId && t.clientId !== clientId);
  const currentListed = all.some((t) => t.id === currentTask.id);
  let filterHonoured = null;
  if (!probes?.defaultList?.available) {
    reasons.push('AroFlo refused the job list filtered by customer (see the raw probe result).');
  } else if (foreign.length) {
    filterHonoured = false;
    reasons.push(`AroFlo returned ${foreign.length} job(s) belonging to other customers — the customer filter was not applied.`);
  } else if (!currentListed && defaultItems.length < 100) {
    filterHonoured = false;
    reasons.push("The current job itself wasn't in the customer's job list, so the list can't be trusted.");
  } else {
    filterHonoured = true;
  }

  // Are archived jobs included without asking for them?
  const defaultIds = new Set(defaultItems.map((t) => t.id));
  let archivedIncludedByDefault = null;
  if (probes?.archivedList?.available && archivedItems.length) {
    archivedIncludedByDefault = archivedItems.every((t) => defaultIds.has(t.id));
  }

  const defaultTotal = totalOf(probes?.defaultList);
  const archivedTotal = totalOf(probes?.archivedList);
  const truncated =
    (defaultTotal !== null && defaultTotal > defaultItems.length) || (archivedTotal !== null && archivedTotal > archivedItems.length);
  if (truncated) reasons.push('This customer has more than 100 jobs in one list — only the first page was read.');
  if (probes?.archivedList && !probes.archivedList.available) reasons.push("Archived jobs couldn't be checked separately.");

  // Every job of this customer, once, oldest job number first.
  const byId = new Map();
  [...defaultItems, ...archivedItems].forEach((t) => byId.set(t.id, t));
  const jobs = [...byId.values()].sort((a, b) => Number(a.jobNumber) - Number(b.jobNumber));

  const current = slimTask(currentTask);
  const others = jobs.filter((t) => t.id !== current.id);
  // "Earlier" by job number (AroFlo numbers jobs in sequence) — the dates
  // are compared too, and any disagreement is reported rather than resolved.
  const earlier = others.filter((t) => Number(t.jobNumber) < Number(current.jobNumber));
  const dateDisagreements = others.filter((t) => {
    const byDate = earlierDate(t.created || t.requested, current.created || current.requested);
    return byDate !== null && byDate !== Number(t.jobNumber) < Number(current.jobNumber);
  });
  if (dateDisagreements.length) reasons.push(`${dateDisagreements.length} job(s) are ordered differently by job number and by created date.`);
  const earlierCompleted = earlier.filter((t) => t.completed || COMPLETED.has(t.status.toUpperCase()));
  const earlierNotCompleted = earlier.filter((t) => !earlierCompleted.includes(t));

  // Things that make "same customer record" a weak sign of "same person
  // who has used us before".
  const siteIds = new Set(jobs.map((t) => t.locationId).filter(Boolean));
  const multipleSites = siteIds.size > 1 || locationItems.length > 1;
  if (client.individual === false) reasons.push('The AroFlo customer is an organisation (e.g. an agency, builder or business), not an individual — its jobs may be for different people or properties.');
  if (multipleSites) reasons.push(`The customer has ${Math.max(siteIds.size, locationItems.length)} sites/locations — earlier jobs may be at a different property.`);
  if (client.parent?.id) reasons.push(`The customer sits under a parent customer (${client.parent.name || client.parent.id}).`);
  if (earlierNotCompleted.length && !earlierCompleted.length) reasons.push('Earlier jobs exist but none was completed (e.g. quotes or cancellations) — not proof they used us before.');

  const reliable = filterHonoured === true && !truncated && probes?.archivedList?.available !== false && reasons.length === 0;
  let assessment = 'uncertain';
  if (reliable && earlierCompleted.length) assessment = 'repeat';
  else if (reliable && !earlier.length) assessment = 'new';

  return {
    clientId,
    clientName: client.name || currentTask.client?.name || null,
    individual: client.individual ?? null,
    parent: client.parent ? { id: client.parent.id, name: client.parent.name || null } : null,
    linkedBusinessUnits: Array.isArray(client.linkedBusinessUnits) ? client.linkedBusinessUnits.length : null,
    filterHonoured,
    archivedIncludedByDefault,
    totals: { defaultList: defaultTotal, archivedOnly: archivedTotal, locations: locationItems.length },
    statusesSeen: [...new Set(jobs.map((t) => t.status))],
    currentJob: current,
    earlierJobs: earlier,
    earlierCompletedCount: earlierCompleted.length,
    laterJobs: others.filter((t) => !earlier.includes(t)),
    assessment,
    reasons,
  };
}
