import { useEffect, useState } from 'react';
import { fetchDashboard } from './api.js';
import KpiTile from './components/KpiTile.jsx';
import JobStatusBars from './components/JobStatusBars.jsx';
import TechnicianTable from './components/TechnicianTable.jsx';

const POLL_MS = 60000;

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchDashboard();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Technician Dashboard</h1>
        {data && (
          <span className="page-header__meta">
            {data.mode === 'mock' && <span className="mode-pill">Sample data</span>}
            Updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      {error && !data && <div className="banner banner--error">Couldn't load dashboard data: {error}</div>}

      {!data && !error && <div className="banner">Loading…</div>}

      {data && (
        <>
          <section className="kpi-row">
            <KpiTile label="Technicians active" value={`${data.summary.techniciansActive}/${data.summary.techniciansTotal}`} />
            <KpiTile label="Jobs in progress" value={data.summary.jobsInProgress} />
            <KpiTile label="Completed today" value={data.summary.jobsCompletedToday} />
            <KpiTile
              label="Overdue"
              value={data.summary.jobsOverdue}
              sublabel={data.summary.jobsOverdue > 0 ? 'Needs attention' : undefined}
            />
            <KpiTile label="Hours logged today" value={data.summary.hoursLoggedToday.toFixed(1)} />
          </section>

          <section className="panel">
            <h2>Jobs today by status</h2>
            <JobStatusBars breakdown={data.jobStatusBreakdown} />
          </section>

          <section className="panel">
            <h2>Technicians</h2>
            <TechnicianTable technicians={data.technicians} />
          </section>
        </>
      )}
    </div>
  );
}
