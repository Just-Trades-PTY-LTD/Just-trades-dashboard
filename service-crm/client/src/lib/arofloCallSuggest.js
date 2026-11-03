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
  const jt = matchJobType(result.taskType, trades);
  const ls = matchLeadSource(result.leadSource, leadSources);
  return {
    found: true,
    status: result.status || '',
    jobType: {
      arofloValue: result.taskType || '',
      suggestion: jt,
      alreadySet: !!jt && same(form.tradeId, jt.tradeId) && same(form.jobTypeId, jt.jobTypeId),
    },
    leadSource: {
      arofloValue: result.leadSource || '',
      suggestion: ls,
      alreadySet: !!ls && same(form.leadSourceId, ls.leadSourceId),
    },
    suburb: {
      arofloValue: result.suburb || '',
      suggestion: result.suburb ? { suburb: result.suburb, label: result.suburb } : null,
      alreadySet: !!result.suburb && same(form.suburb, result.suburb),
    },
  };
}
