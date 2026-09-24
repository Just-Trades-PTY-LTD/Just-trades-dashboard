import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { PieCardBody, BarCardBody, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';

function emptyFilters() {
  return { from: '', to: '', handledByUserId: '' };
}

export default function CallsReport() {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [data, setData] = useState(null);
  const layout = useReportLayout('calls');

  useEffect(() => {
    api.reports.calls(filters).then(setData);
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, staffPerf } = data;

  const kpiRows = [
    ['Total Contacts', kpis.total],
    ['Inbound Calls', kpis.inboundCount],
    ['Outbound Calls', kpis.outboundCount],
    ['Text Messages', kpis.textMessageCount],
    ['Emails', kpis.emailCount],
    ['Other / N/A', kpis.otherContactCount],
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

      <div style={{ marginBottom: 20 }}>
        <AdjustableSection id="kpis" title="Summary figures" defaultSize="md" layout={layout}>
          {(cfg) => (
            <div className="grid-cards" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.kpiMinCardWidth}px, 1fr))` }}>
              {kpiRows.map(([label, val]) => (
                <div key={label} className="panel" style={{ padding: '16px 18px' }}>
                  <div className="kpi-val">{val}</div>
                  <div className="kpi-label">{label}</div>
                </div>
              ))}
            </div>
          )}
        </AdjustableSection>
      </div>

      {kpis.total === 0 ? (
        <div className="panel empty-state">No calls logged in this range yet.</div>
      ) : (
        <div className="grid-charts">
          <AdjustableSection id="byTrade" title="Calls by trade" defaultSize="md" layout={layout}>
            {(cfg) => <PieCardBody data={byTrade} height={cfg.chartHeight} />}
          </AdjustableSection>

          <AdjustableSection id="bySourcePie" title="Leads by referral source" defaultSize="md" layout={layout}>
            {(cfg) => <PieCardBody data={bySourcePie} height={cfg.chartHeight} />}
          </AdjustableSection>

          <AdjustableSection id="bySourceStack" title="Leads by source — booked vs not" defaultSize="md" layout={layout}>
            {(cfg) => (
              <ResponsiveContainer width="100%" height={cfg.chartHeight}>
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
            )}
          </AdjustableSection>

          <AdjustableSection id="notBookedReasons" title="Why leads aren't booking" defaultSize="md" layout={layout}>
            {(cfg) => <BarCardBody data={notBookedReasons} color="#a15c17" height={cfg.chartHeight} />}
          </AdjustableSection>

          <AdjustableSection id="newCancelReasons" title="New Job Cancellation reasons" defaultSize="md" layout={layout}>
            {(cfg) => <BarCardBody data={newCancelReasons} color="#a3323a" height={cfg.chartHeight} />}
          </AdjustableSection>

          <AdjustableSection id="pendingCancelReasons" title="Pending Cancellation reasons" defaultSize="md" layout={layout}>
            {(cfg) => <BarCardBody data={pendingCancelReasons} color="#8a4fbf" height={cfg.chartHeight} />}
          </AdjustableSection>

          <AdjustableSection id="trend" title="Calls over time" defaultSize="lg" layout={layout}>
            {(cfg) => (
              <ResponsiveContainer width="100%" height={cfg.chartHeight}>
                <LineChart data={trend}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" stroke="var(--ink-muted)" fontSize={11} />
                  <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" stroke="#1b75ba" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </AdjustableSection>

          <AdjustableSection id="byStaff" title="By staff" defaultSize="lg" layout={layout}>
            {(cfg) => (
              <div className="table-scroll" style={cfg.tableMaxHeight ? { maxHeight: cfg.tableMaxHeight, overflowY: 'auto' } : undefined}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th>Total Contacts</th>
                      <th>Inbound Calls</th>
                      <th>Outbound Calls</th>
                      <th>Text Messages</th>
                      <th>Emails</th>
                      <th>Other / N/A</th>
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
                        <td>{s.inbound}</td>
                        <td>{s.outbound}</td>
                        <td>{s.textMessage}</td>
                        <td>{s.email}</td>
                        <td>{s.otherContact}</td>
                        <td>{s.leads}</td>
                        <td>{s.booked}</td>
                        <td>{s.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdjustableSection>
        </div>
      )}
    </div>
  );
}
