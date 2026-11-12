// New Job Cancellation (Calls & Contacts): Trade, Job type and Suburb from
// the Technician & Sales job with the same Job Number, or — when there's no
// job — the booked Lead call(s) with it. Pure (tested); nothing is saved.
//
// `origin` is /lookup/cancellation-origin. `form` is the call form with this
// source's own earlier fills already treated as blank. `allowFill`: a new
// cancellation, or a saved one getting its first Job Number; otherwise
// differences are only offered ("Use this").
// Returns { wanted, suggestions: [{ label, values }], sourceLabel, notes }.

const same = (a, b) => String(a ?? '') === String(b ?? '');
const fmtDate = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(d || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
};

export function planCancellationFill({ origin, form, allowFill, jobNumber }) {
  const out = { wanted: {}, suggestions: [], sourceLabel: null, notes: [] };
  if (!origin?.found) return out;

  let tradeOptions = [];
  let suburbOptions = [];
  if (origin.source === 'job') {
    const j = origin.job;
    out.sourceLabel = `the Technician & Sales job for JN ${jobNumber}`;
    if (j.tradeId) tradeOptions = [{ tradeId: j.tradeId, jobTypeId: j.jobTypeId, label: [j.trade, j.jobType].filter(Boolean).join(' — '), from: 'the job' }];
    if (j.suburb) suburbOptions = [{ suburb: j.suburb, from: 'the job' }];
  } else {
    const calls = origin.calls || [];
    out.sourceLabel =
      calls.length === 1 ? `the booked Lead call for JN ${jobNumber} (${fmtDate(calls[0].date)})` : `the ${calls.length} booked Lead calls for JN ${jobNumber}`;
    // Trade + Job type are one pair from one call, never mixed across calls.
    const pairs = new Map();
    calls.filter((c) => c.tradeId).forEach((c) => {
      const k = `${c.tradeId}|${c.jobTypeId || ''}`;
      if (!pairs.has(k)) pairs.set(k, { tradeId: c.tradeId, jobTypeId: c.jobTypeId, label: [c.trade, c.jobType].filter(Boolean).join(' — '), from: `call ${fmtDate(c.date)}` });
    });
    tradeOptions = [...pairs.values()];
    const suburbs = new Map();
    calls.filter((c) => c.suburb).forEach((c) => {
      if (!suburbs.has(c.suburb)) suburbs.set(c.suburb, { suburb: c.suburb, from: `call ${fmtDate(c.date)}` });
    });
    suburbOptions = [...suburbs.values()];
  }

  // Trade / Job type.
  if (tradeOptions.length === 1) {
    const o = tradeOptions[0];
    const values = { tradeId: o.tradeId, jobTypeId: o.jobTypeId || '' };
    if (allowFill && !form.tradeId && !form.jobTypeId) {
      out.wanted.tradeId = o.tradeId;
      if (o.jobTypeId) out.wanted.jobTypeId = o.jobTypeId;
    } else if (!same(form.tradeId, o.tradeId) || (o.jobTypeId && !same(form.jobTypeId, o.jobTypeId))) {
      out.suggestions.push({ label: `Trade / Job type: ${o.label}`, values });
    }
  } else if (tradeOptions.length > 1) {
    out.notes.push(`The booked Lead calls for JN ${jobNumber} have different Trade / Job types — choose the right one.`);
    tradeOptions.forEach((o) => {
      if (!same(form.tradeId, o.tradeId) || !same(form.jobTypeId, o.jobTypeId || '')) out.suggestions.push({ label: `Trade / Job type: ${o.label} (${o.from})`, values: { tradeId: o.tradeId, jobTypeId: o.jobTypeId || '' } });
    });
  }

  // Suburb.
  if (suburbOptions.length === 1) {
    const o = suburbOptions[0];
    if (allowFill && !form.suburb) out.wanted.suburb = o.suburb;
    else if (!same(form.suburb, o.suburb)) out.suggestions.push({ label: `Suburb: ${o.suburb}`, values: { suburb: o.suburb } });
  } else if (suburbOptions.length > 1) {
    out.notes.push(`The booked Lead calls for JN ${jobNumber} have different suburbs — choose the right one.`);
    suburbOptions.forEach((o) => {
      if (!same(form.suburb, o.suburb)) out.suggestions.push({ label: `Suburb: ${o.suburb} (${o.from})`, values: { suburb: o.suburb } });
    });
  }
  return out;
}

const LABELS = { tradeId: 'Trade', jobTypeId: 'Job type', suburb: 'Suburb' };
/** "Filled from <source>: Trade, Job type, Suburb — still editable." */
export function cancellationFillConfirmation(sourceLabel, filled) {
  const names = Object.keys(filled || {}).map((f) => LABELS[f]).filter(Boolean);
  return sourceLabel && names.length ? `Filled from ${sourceLabel}: ${names.join(', ')} — still editable.` : null;
}
