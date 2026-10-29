// What the New Job form says about where this Job Number's Lead Source will
// come from in the reports. The reports credit a job's Lead Source only to
// the earliest active Lead call booked "Yes" with the same Job Number
// (server: findReportingLeadCall); a job without one reports as
// "Unassigned". Read-only: nothing here changes the form or any record.
//
// `callLookup` is the /lookup/call result for the typed Job Number (null
// while it's still loading or no Job Number is entered).
export function leadCallStatus(jobNumber, callLookup) {
  const jn = (jobNumber || '').trim();
  if (!jn || !callLookup) return null;

  const lead = callLookup.leadCall;
  if (lead && lead.leadSource) {
    return {
      tone: 'found',
      text: `Lead call found — Lead Source: ${lead.leadSource} (call on ${formatCallDate(lead.callAt)}).`,
    };
  }
  if (lead) {
    return {
      tone: 'missing',
      text: `A booked Lead call exists for JN ${jn} (${formatCallDate(lead.callAt)}) but has no Lead Source selected, so this job will report as "Unassigned" until one is chosen on that call in Calls & Contacts.`,
    };
  }
  if (callLookup.found) {
    const type = callLookup.callType || 'a';
    const bookedNote = callLookup.callType === 'Lead' && callLookup.booked !== 'Yes' ? ' not marked as booked' : '';
    return {
      tone: 'missing',
      text: `The call logged for JN ${jn} is ${type === 'Lead' ? 'a Lead call' : `a "${type}" call`}${bookedNote}. Lead Source reports only use booked Lead calls, so this job will report as "Unassigned". Check that call in Calls & Contacts.`,
    };
  }
  return {
    tone: 'missing',
    text: `No booked Lead call found for JN ${jn}. This job's Lead Source won't appear in reports until one is logged in Calls & Contacts.`,
  };
}

// "2026-10-03T09:15" -> "3 Oct 2026"; anything unreadable is shown as-is.
function formatCallDate(callAt) {
  const m = String(callAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(callAt || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
