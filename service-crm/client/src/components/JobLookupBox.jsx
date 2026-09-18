export function JobLookupBox({ jobNumber, mode, result }) {
  if (!jobNumber || !jobNumber.trim() || !result) return null;

  if (mode === 'sale') {
    if (!result.found) return <div className="lookup-box lookup-missing">No recorded sale found yet for JN {jobNumber}.</div>;
    return (
      <div className="lookup-box lookup-found">
        Matched sale: invoice {result.invoiceNumber} · ${Math.round(result.saleValueExGst).toLocaleString()} ex GST · credited to{' '}
        {result.creditedTechnician || '—'} · {result.invoiceDate}
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
    </div>
  );
}
