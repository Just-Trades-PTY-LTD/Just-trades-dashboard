import StatusBadge from './StatusBadge.jsx';

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function TechnicianTable({ technicians }) {
  return (
    <div className="table-wrap">
      <table className="tech-table">
        <thead>
          <tr>
            <th>Technician</th>
            <th>Status</th>
            <th>Current / next job</th>
            <th className="num">Done today</th>
            <th className="num">Remaining</th>
            <th className="num">Overdue</th>
            <th className="num">Hours today</th>
            <th className="num">Hours this week</th>
          </tr>
        </thead>
        <tbody>
          {technicians.map((tech) => (
            <tr key={tech.staffId}>
              <td>
                <div className="tech-name">{tech.name}</div>
                <div className="tech-role">{tech.role}</div>
              </td>
              <td>
                <StatusBadge status={tech.status} />
              </td>
              <td>
                {tech.currentJob ? (
                  <div className="job-cell">
                    <div className="job-cell__client">{tech.currentJob.clientName}</div>
                    <div className="job-cell__detail">{tech.currentJob.description} · {tech.currentJob.address}</div>
                  </div>
                ) : tech.nextJob ? (
                  <div className="job-cell">
                    <div className="job-cell__client">Next: {tech.nextJob.clientName}</div>
                    <div className="job-cell__detail">{formatTime(tech.nextJob.scheduledStart)} · {tech.nextJob.description}</div>
                  </div>
                ) : (
                  <span className="muted">No jobs scheduled</span>
                )}
              </td>
              <td className="num">{tech.jobsCompletedToday}</td>
              <td className="num">{tech.jobsRemainingToday}</td>
              <td className={`num ${tech.overdueJobs > 0 ? 'num--critical' : ''}`}>{tech.overdueJobs}</td>
              <td className="num tabular">{tech.hoursToday.toFixed(1)}</td>
              <td className="num tabular">{tech.hoursThisWeek.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
