import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { ChartPanel, PieCard, BarCard, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from '../../components/Charts.jsx';

function emptyFilters() {
  return { from: '', to: '', handledByUserId: '' };
}

export default function CallsReport() {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [data, setData] = useState(null);

  useEffect(() => {
    api.reports.calls(filters).then(setData);
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  if (!data) return <div className="empty-state">Loading…</div>;
  const { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, staffPerf } = data;

  const kpiRows = [
    ['Total calls', kpis.total],
    ['Leads', kpis.leadsCount],
    ['Booked leads', kpis.bookedCount],
    ['Booking rate', `${kpis.bookingRate}%`],
    ['Quotes approved', kpis.quotesApproved],
    ['Call back requests', kpis.callBackRequests],
    ['New Job Cancellations', kpis.newJobCancellations],
    ['Pending Cancellations', kpis.pendingCancellations],
  ];

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect label="Staff" value={filters.handledByUserId} onChange={(v) => patch({ handledByUserId: v })} options={settings.staff} />
        <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
          Clear filters
        </button>
        <a className="btn btn-primary" href={api.reports.callsXlsxUrl(filters)} style={{ marginLeft: 'auto' }}>
          Export to Excel
        </a>
      </div>

      <div className="grid-cards" style={{ marginBottom: 20 }}>
        {kpiRows.map(([label, val]) => (
          <div key={label} className="panel" style={{ padding: '16px 18px' }}>
            <div className="kpi-val">{val}</div>
            <div className="kpi-label">{label}</div>
          </div>
        ))}
      </div>

      {kpis.total === 0 ? (
        <div className="panel empty-state">No calls logged in this range yet.</div>
      ) : (
        <div className="grid-charts">
          <PieCard title="Calls by trade" data={byTrade} />
          <PieCard title="Leads by referral source" data={bySourcePie} />
          <ChartPanel title="Leads by source — booked vs not">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={bySourceStack}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--ink-muted)" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
                <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Booked" stackId="a" fill="#1f7a52" />
                <Bar dataKey="Not booked" stackId="a" fill="#a15c17" />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
          <BarCard title="Why leads aren't booking" data={notBookedReasons} color="#a15c17" />
          <BarCard title="New Job Cancellation reasons" data={newCancelReasons} color="#a3323a" />
          <BarCard title="Pending Cancellation reasons" data={pendingCancelReasons} color="#8a4fbf" />
          <ChartPanel title="Calls over time" span2>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trend}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" stroke="var(--ink-muted)" fontSize={11} />
                <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#1b75ba" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>
          <ChartPanel title="By staff" span2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Total calls</th>
                  <th>Leads</th>
                  <th>Booked</th>
                  <th>Booking rate</th>
                </tr>
              </thead>
              <tbody>
                {staffPerf.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.total}</td>
                    <td>{s.leads}</td>
                    <td>{s.booked}</td>
                    <td>{s.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartPanel>
        </div>
      )}
    </div>
  );
}
