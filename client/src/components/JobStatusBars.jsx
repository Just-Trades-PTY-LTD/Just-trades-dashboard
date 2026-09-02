const DOT_CLASS = {
  scheduled: 'status-dot--info',
  in_progress: 'status-dot--accent',
  on_hold: 'status-dot--warning',
  completed: 'status-dot--good',
  overdue: 'status-dot--critical',
};

const BAR_CLASS = {
  scheduled: 'job-bar__fill--info',
  in_progress: 'job-bar__fill--accent',
  on_hold: 'job-bar__fill--warning',
  completed: 'job-bar__fill--good',
  overdue: 'job-bar__fill--critical',
};

export default function JobStatusBars({ breakdown }) {
  const max = Math.max(1, ...breakdown.map((row) => row.count));

  return (
    <div className="job-bars" role="img" aria-label="Job status breakdown for today">
      {breakdown.map((row) => (
        <div className="job-bars__row" key={row.status}>
          <span className="job-bars__label">
            <span className={`status-dot ${DOT_CLASS[row.status] || ''}`} aria-hidden="true" />
            {row.label}
          </span>
          <div className="job-bar">
            <div
              className={`job-bar__fill ${BAR_CLASS[row.status] || ''}`}
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </div>
          <span className="job-bars__value">{row.count}</span>
        </div>
      ))}
    </div>
  );
}
