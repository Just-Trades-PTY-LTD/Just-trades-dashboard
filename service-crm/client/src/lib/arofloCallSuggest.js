// What a "Look up in AroFlo" result can suggest on a Lead call: a Trade +
// Job type, a Lead Source and a Suburb. Suggestions only — nothing is applied until
// staff click "Use this", and nothing is saved until they save the call.
//
// Matching is deliberately strict, the same "never guess" rule as the other
// AroFlo fills: a suggestion is offered only when exactly ONE of this CRM's
// own options has the same name as AroFlo's value (ignoring case, spacing
// and punctuation). AroFlo's task types and its customer-level Lead Source
// options don't line up 1:1 with this CRM's lists (e.g. AroFlo's single
// "Google" vs. "Google search"/"Google ads" here), so anything else is shown
// as a plain reference value for staff to pick the closest match themselves.
// The Suburb is already matched by the server (aroflo/suburbMatch.js) from
// the job's AroFlo address, and is null unless exactly one suburb in this
// CRM's list matches — the same rule the New Job form uses.

export function normName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The single Trade + Job type whose name matches AroFlo's task type (either
 * the job type's own name, or "Trade Job type"), or null. */
export function matchJobType(taskType, trades) {
  const key = normName(taskType);
  if (!key) return null;
  const matches = [];
  for (const t of trades || []) {
    for (const jt of t.jobTypes || []) {
      if (normName(jt.name) === key || normName(`${t.name} ${jt.name}`) === key) {
        matches.push({ tradeId: t.id, jobTypeId: jt.id, label: `${t.name} — ${jt.name}` });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** The single Lead Source whose name matches AroFlo's, or null. */
export function matchLeadSource(arofloLeadSource, leadSources) {
  const key = normName(arofloLeadSource);
  if (!key) return null;
  const matches = (leadSources || []).filter((ls) => normName(ls.name) === key);
  return matches.length === 1 ? { leadSourceId: matches[0].id, label: matches[0].name } : null;
}

const same = (a, b) => String(a ?? '') === String(b ?? '');

// Trade / Job type from AroFlo's task type. The server resolves it once for
// both forms (taskTypeMatch: an admin mapping first, then the exact-name
// fallback); an older server without it falls back to the exact-name rule
// here. kind 'tradeOnly' suggests the Trade only and lists the Job type
// choices for staff; kind 'callback' suggests nothing (it says nothing about
// the trade) and never changes the call type.
// The customer's AroFlo Lead Source. The server resolves it (leadSourceMatch:
// an admin mapping first, then the exact name; both AroFlo fields checked):
// 'mapped' -> a "Use this" suggestion; 'unmapped' -> reference only;
// 'conflict' (the two AroFlo fields disagree) -> both shown, no suggestion,
// left for staff. An older server without it falls back to the exact-name
// rule here. Never applied on its own; never overwrites a staff choice.
function leadSourceSummary(result, form, exactFallback) {
  const m = result.leadSourceMatch;
  if (!m) {
    return { arofloValue: result.leadSource || '', suggestion: exactFallback, alreadySet: !!exactFallback && same(form.leadSourceId, exactFallback.leadSourceId) };
  }
  const values = m.values || [];
  const arofloValue = [...new Set(values.map((v) => v.value))].join(' / ');
  if (m.kind === 'mapped') {
    const suggestion = { leadSourceId: m.leadSourceId, label: m.label };
    return { arofloValue, suggestion, alreadySet: same(form.leadSourceId, m.leadSourceId), kind: 'mapped', source: m.source, values };
  }
  return { arofloValue, suggestion: null, alreadySet: false, kind: m.kind, values };
}

function jobTypeSummary(result, form, trades) {
  const arofloValue = result.taskType || '';
  const m = result.taskTypeMatch;
  if (!m) {
    const jt = matchJobType(result.taskType, trades);
    return { arofloValue, suggestion: jt, alreadySet: !!jt && same(form.tradeId, jt.tradeId) && same(form.jobTypeId, jt.jobTypeId) };
  }
  if (m.kind === 'full') {
    const suggestion = { tradeId: m.tradeId, jobTypeId: m.jobTypeId, label: m.label };
    return { arofloValue, suggestion, alreadySet: same(form.tradeId, m.tradeId) && same(form.jobTypeId, m.jobTypeId), kind: 'full', source: m.source };
  }
  if (m.kind === 'tradeOnly') {
    const suggestion = { tradeId: m.tradeId, jobTypeId: '', label: m.label };
    return { arofloValue, suggestion, alreadySet: same(form.tradeId, m.tradeId), kind: 'tradeOnly', source: m.source, choices: m.choices || [] };
  }
  return { arofloValue, suggestion: null, alreadySet: false, kind: m.kind, source: m.source };
}

/**
 * Everything the call form shows after a lookup. `result` is the
 * /aroflo/lookup response (or { found: false, message } on failure).
 * Returns { found, message, status, jobType, leadSource, suburb } where
 * each is { arofloValue, suggestion, alreadySet } — suggestion is
 * null when there's no single confident match, and alreadySet is true when
 * the form already holds exactly the suggested value.
 */
export function callLookupSummary(result, form, { trades, leadSources }) {
  if (!result?.found) {
    return { found: false, message: result?.message || 'No matching AroFlo job found.' };
  }
  const ls = matchLeadSource(result.leadSource, leadSources);
  return {
    found: true,
    status: result.status || '',
    jobType: jobTypeSummary(result, form, trades),
    leadSource: leadSourceSummary(result, form, ls),
    suburb: {
      arofloValue: result.suburb || '',
      suggestion: result.suburb ? { suburb: result.suburb, label: result.suburb } : null,
      alreadySet: !!result.suburb && same(form.suburb, result.suburb),
      // Read-only reference when no confident suburb was found.
      addressForReference: result.suburb ? null : result.addressForReference || null,
    },
  };
}

/**
 * The Lead Source to show on a Lead call once the automatic customer-history
 * check is in, in the agreed order:
 * 1. callback -> 'callback': no Lead Source suggestion;
 * 2. confident repeat -> 'repeat': suggest Repeat customer, with AroFlo's
 *    own (original) Lead Source shown as reference only;
 * 3. no earlier completed job, or the check couldn't run -> 'normal': the
 *    mapped AroFlo Lead Source as before (leadSourceSummary);
 * 4. uncertain history -> 'uncertain': no suggestion, reasons shown.
 * While the check is still running -> 'checking': no suggestion yet, so a
 * mapped source can't be accepted moments before Repeat customer appears.
 * Suggestions only — never applied on their own.
 */
export function leadSourceDecision(leadSource, history, form, leadSources) {
  const original = leadSource?.arofloValue || '';
  if (!history) return { mode: 'normal', original };
  if (history.status === 'checking') return { mode: 'checking', original };
  const r = history.result;
  if (!r || !r.found || r.kind === 'unavailable') return { mode: 'normal', original };
  const occupant = r.occupant || null; // reference only, for every Occupant value
  // No genuine possibility of earlier work: the mapped AroFlo customer-card
  // source applies; eligibility warnings (organisation, several sites) are information only.
  // `historyConfirmed`: the check ran and found no earlier completed work —
  // only then may the mapped source be filled automatically (stage 2).
  if (r.kind === 'no-earlier') return { mode: 'normal', original, occupant, warnings: r.warnings || [], historyConfirmed: true };
  if (r.kind === 'callback') return { mode: 'callback', original, reasons: r.reasons || [] };
  if (r.kind === 'repeat') {
    const repeat = (leadSources || []).filter((l) => normName(l.name) === 'repeat customer');
    if (repeat.length !== 1) {
      return { mode: 'uncertain', original, occupant, reasons: ['AroFlo history shows a returning customer, but there is no single "Repeat customer" Lead Source in Settings.'] };
    }
    return {
      mode: 'repeat',
      original,
      occupant,
      earlierJob: r.earlierJob || null,
      suggestion: { leadSourceId: repeat[0].id, label: repeat[0].name },
      alreadySet: same(form.leadSourceId, repeat[0].id),
    };
  }
  return { mode: 'uncertain', original, occupant, reasons: [...(r.reasons || []), ...(r.warnings || [])] };
}

/**
 * Stage 2 — what a booked Lead call's automatic lookup fills, BLANK fields
 * only (the caller tracks and takes back its own fills when the Job Number
 * changes; a staff choice is never replaced). Nothing is saved here.
 * - Suburb: AroFlo's single confident suburb match.
 * - Trade / Job type: a full task-type match fills both; a Trade-only match
 *   fills the Trade (Job type left for staff); a Call Back task type or no
 *   single match fills nothing. Only when both fields are blank.
 * - Lead Source, only once the customer-history check is finished, in the
 *   agreed order: callback -> nothing; confident repeat -> Repeat customer;
 *   uncertain (or the check couldn't run) -> nothing, left for staff; no
 *   earlier completed work -> the mapped AroFlo customer-card source (an
 *   unmapped or conflicting value -> nothing).
 * Returns { wanted: { field: value }, labels: { field: 'Suburb' | ... } }.
 */
export function planLeadCallFill({ summary, decision, form }) {
  const wanted = {};
  if (!summary?.found) return { wanted };
  if (summary.suburb?.suggestion && !form.suburb) wanted.suburb = summary.suburb.suggestion.suburb;
  const jt = summary.jobType?.suggestion;
  if (jt && !form.tradeId && !form.jobTypeId) {
    wanted.tradeId = jt.tradeId;
    if (jt.jobTypeId) wanted.jobTypeId = jt.jobTypeId;
  }
  if (!form.leadSourceId && decision) {
    if (decision.mode === 'repeat' && decision.suggestion) wanted.leadSourceId = decision.suggestion.leadSourceId;
    else if (decision.mode === 'normal' && decision.historyConfirmed && summary.leadSource?.kind === 'mapped' && summary.leadSource.suggestion) {
      wanted.leadSourceId = summary.leadSource.suggestion.leadSourceId;
    }
  }
  return { wanted };
}

const FILL_LABELS = { suburb: 'Suburb', tradeId: 'Trade', jobTypeId: 'Job type', leadSourceId: 'Lead Source' };
/** "Filled from AroFlo: Suburb, Trade, Job type — check before saving." (names only) */
export function leadCallFillConfirmation(filled) {
  const names = Object.keys(filled || {}).map((f) => FILL_LABELS[f]).filter(Boolean);
  return names.length ? `Filled from AroFlo: ${names.join(', ')} — still editable, check before saving.` : null;
}
