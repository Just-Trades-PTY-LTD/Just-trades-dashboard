// `approvedQuote`: the Quote Approved Later form's Original Job Number, where
// a number with no job entry may instead be an earlier approved quote's New
// Job Number that hasn't been recorded on that sale yet.
export function JobLookupBox({ jobNumber, mode, result, approvedQuote = false }) {
  if (!jobNumber || !jobNumber.trim() || !result) return null;

  if (mode === 'sale') {
    if (!result.found) return <div className="lookup-box lookup-missing">No recorded sale found yet for JN {jobNumber}.</div>;
    return (
      <div className="lookup-box lookup-found">
        Matched sale: {result.trade}
        {result.jobType ? ` — ${result.jobType}` : ''} · invoice {result.invoiceNumber} · ${Math.round(result.saleValueExGst).toLocaleString()}{' '}
        ex GST · credited to {result.creditedTechnician || '—'} · {result.invoiceDate}
      </div>
    );
  }

  if (!result.found && approvedQuote) {
    const jn = jobNumber.trim();
    return (
      <div className="lookup-box lookup-missing" data-testid="qal-no-match">
        No job entry or earlier approved sale has JN {jn}.
        <br />
        If {jn} is the New Job Number of an earlier approved quote (new work quoted during that job), first add {jn} as that sale's{' '}
        <strong>New Job Number</strong>: Job history → Edit that sale → New Job Number → Update entry. Then enter {jn} here again and
        tick the follow-on box.
      </div>
    );
  }
  if (!result.found) {
    return (
      <div className="lookup-box lookup-missing">
        No matching job found yet for JN {jobNumber} — it will link automatically once that job is entered.
      </div>
    );
  }
  return (
    <div className="lookup-box lookup-found">
      Matched job: {result.trade}
      {result.jobType ? ` — ${result.jobType}` : ''} · attended by {result.technician || '—'} on {result.visitDate}
      {result.hadSaleAtVisit ? ' · sale already recorded' : result.convertedLater ? ' · later converted to a sale' : ' · currently a knock-back'}
      {approvedQuote && result.convertedLater && !result.hadSaleAtVisit && (
        <div style={{ marginTop: 4 }} data-testid="qal-converted-hint">
          This knock-back has already been converted by an approved quote. If this is new work quoted during that approved job, enter that
          approved quote's New Job Number as the Original Job Number instead — it is then recorded as a follow-on approved quote (Repeat
          customer).
        </div>
      )}
    </div>
  );
}
