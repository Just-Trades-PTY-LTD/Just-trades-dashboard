import { all } from '../db/index.js';

// Which CRM suburb an AroFlo job is at — the one shared matcher behind every
// AroFlo suburb suggestion/fill (Calls & Contacts and Technician & Sales).
//
// Source: always the JOB'S own site — the task's structured `location`
// (suburb + postcode) when AroFlo has one, otherwise the task's own address
// text (`locationText`, e.g. "65 Tyne Avenue Kilburn SA 5084 AUSTRALIA").
// Never the customer's postal/billing address.
//
// Rule — a suburb is returned only when it is certain:
// - the address must be South Australian ("SA" or "South Australia") and end
//   with a 4-digit postcode ("AUSTRALIA", commas and extra spaces optional);
// - the suburb and postcode must agree with the CRM's own suburb list;
// - from the address text, the suburb is the CRM name (for that postcode)
//   that the words immediately before the state end with. The longest such
//   name wins, so "South Brighton" is never read as "Brighton", and a street
//   named after another suburb ("Glynde Road, Firle") is ignored.
// Anything else — no postcode, an interstate address, a postcode not in the
// list, a misspelt or mismatched suburb, two equally good names — returns
// null and the field is left for staff. Read-only: nothing is stored.

const STATE_SA = '(?:SA|S\\.A\\.|South\\s+Australia)';
const SA_TAIL = new RegExp(`^(.*?)[\\s,]+${STATE_SA}[\\s,]+(\\d{4})(?:[\\s,]+Australia)?[\\s,.]*$`, 'i');
const OTHER_STATE = /\b(?:NSW|VIC|QLD|WA|TAS|NT|ACT|New\s+South\s+Wales|Victoria|Queensland|Western\s+Australia|Tasmania|Northern\s+Territory|Australian\s+Capital\s+Territory)\b[\s,]+\d{4}\b/i;

const words = (v) => ` ${String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const label = (s) => `${s.name} (${s.postcode})`;
const candidatesFor = (postcode) => all('SELECT name, postcode FROM suburbs WHERE postcode = ?', [postcode]);

const result = (suburb, status, reason, source) => ({ suburb, status, reason, source });

// The task's structured site record, when AroFlo has one.
function fromSiteRecord(location) {
  const suburb = String(location?.suburb || '').trim();
  const postcode = String(location?.postCode ?? location?.postcode ?? '').trim();
  if (!suburb || !/^\d{4}$/.test(postcode)) return null;
  const state = String(location.state || '').trim();
  if (state && !new RegExp(`^${STATE_SA}$`, 'i').test(state)) {
    return result(null, 'rejected', `the site record is in ${state}, not South Australia`, 'site record');
  }
  const candidates = candidatesFor(postcode);
  if (!candidates.length) return result(null, 'rejected', `postcode ${postcode} isn't in the CRM suburb list`, 'site record');
  const hits = candidates.filter((c) => words(c.name) === words(suburb));
  if (hits.length === 1) return result(label(hits[0]), 'matched', null, 'site record');
  return result(null, 'uncertain', `the site record's suburb doesn't match a CRM suburb for postcode ${postcode}`, 'site record');
}

// The task's own address text.
function fromAddressText(text) {
  const address = String(text || '').trim();
  if (!address) return result(null, 'rejected', 'AroFlo has no job address', 'job address');
  const tail = address.match(SA_TAIL);
  if (!tail) {
    if (OTHER_STATE.test(address)) return result(null, 'rejected', 'the job address is outside South Australia', 'job address');
    return result(null, 'rejected', 'the job address has no "SA" + postcode at the end', 'job address');
  }
  const [, before, postcode] = tail;
  const candidates = candidatesFor(postcode);
  if (!candidates.length) return result(null, 'rejected', `postcode ${postcode} isn't in the CRM suburb list`, 'job address');
  const ending = words(before);
  const enders = candidates.filter((c) => ending.endsWith(words(c.name)));
  if (!enders.length) {
    return result(null, 'uncertain', `no CRM suburb for postcode ${postcode} appears just before "SA ${postcode}" (misspelt, or a suburb that doesn't match the postcode)`, 'job address');
  }
  const longest = Math.max(...enders.map((c) => words(c.name).length));
  const best = enders.filter((c) => words(c.name).length === longest);
  if (best.length !== 1) return result(null, 'uncertain', `${best.length} CRM suburbs match equally`, 'job address');
  return result(label(best[0]), 'matched', null, 'job address');
}

/**
 * Full answer for one AroFlo job: { suburb, status, reason, source }.
 * status is 'matched' (suburb set), 'uncertain' (a valid SA address, but no
 * single CRM suburb fits — staff to check) or 'rejected' (no usable SA
 * address/postcode). suburb is null unless matched.
 */
export function analyzeTaskSuburb({ location, locationText } = {}) {
  const site = fromSiteRecord(location);
  const text = locationText ? fromAddressText(locationText) : null;
  if (site?.status === 'matched' && text?.status === 'matched' && site.suburb !== text.suburb) {
    return result(null, 'uncertain', `the site record says ${site.suburb} but the job address says ${text.suburb}`, 'site record');
  }
  if (site?.status === 'matched') return site;
  if (text?.status === 'matched') return text;
  return text || site || result(null, 'rejected', 'AroFlo has no job address', null);
}

/** The CRM suburb ("Name (postcode)") for a task, or null — never a guess. */
export function matchSuburbForTask(task) {
  return analyzeTaskSuburb({ location: task?.location, locationText: task?.locationText }).suburb;
}

/** The CRM suburb for a job's address text alone, or null. */
export function matchSuburbFromLocationText(locationText) {
  return fromAddressText(locationText).suburb;
}

// The matcher used before this change — kept ONLY so the admin AroFlo Test
// page can show "current vs proposed" side by side on real jobs. Nothing
// else uses it.
export function legacyMatchSuburbFromLocationText(locationText) {
  if (!locationText) return null;
  const postcodeMatch = locationText.match(/\bSA\s+(\d{4})\s+AUSTRALIA\b/i);
  if (!postcodeMatch) return null;
  const candidates = candidatesFor(postcodeMatch[1]);
  if (!candidates.length) return null;
  const haystack = locationText.toLowerCase();
  const nameMatches = candidates.filter((c) => haystack.includes(c.name.toLowerCase()));
  if (nameMatches.length !== 1) return null;
  return label(nameMatches[0]);
}
