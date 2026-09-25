import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { PieCardBody, BarCardBody, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, tradeColor } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import DrilldownModal from '../../components/DrilldownModal.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

function emptyFilters() {
  return { from: '', to: '', handledByUserId: '' };
}

export default function CallsReport({ jumpToJN }) {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [data, setData] = useState(null);
  const [drilldown, setDrilldown] = useState(null);
  const layout = useReportLayout('calls');

  useEffect(() => {
    api.reports.calls(filters).then(setData);
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  // Every clickable figure/chart section opens the same modal against the
  // /reports/calls/drilldown endpoint, carrying this report's own current
  // filters (from/to/staff) plus whichever selector that figure needs — see
  // services/reports.js's drilldownCalls() for the full list of metrics.
  function openDrilldown(metric, extra) {
    setDrilldown({ ...filters, metric, ...extra });
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { kpis, byTrade, bySourcePie, bySourceStack, notBookedReasons, newCancelReasons, pendingCancelReasons, trend, staffPerf } = data;

  const kpiRows = [
    ['Total Contacts', kpis.total, 'total'],
    ['Inbound Calls', kpis.inboundCount, 'inbound'],
    ['Outbound Calls', kpis.outboundCount, 'outbound'],
    ['Text Messages', kpis.textMessageCount, 'textMessage'],
    ['Emails', kpis.emailCount, 'email'],
    ['Other / N/A', kpis.otherContactCount, 'otherContact'],
    ['Leads', kpis.leadsCount, 'leads'],
    ['Booked leads', kpis.bookedCount, 'booked'],
    ['Booking rate', `${kpis.bookingRate}%`, 'bookingRate'],
    ['Quotes approved', kpis.quotesApproved, 'quotesApproved'],
    ['Call back requests', kpis.callBackRequests, 'callBackRequests'],
    ['New Job Cancellations', kpis.newJobCancellations, 'newJobCancellations'],
    ['Pending Cancellations', kpis.pendingCancellations, 'pendingCancellations'],
  ];

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect
          label="Staff"
          value={filters.handledByUserId}
          onChange={(v) => patch({ handledByUserId: v })}
          options={withInactiveLabel(settings.staffAll)}
        />
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
              {kpiRows.map(([label, val, metric]) => (
                <div
                  key={label}
                  className="panel clickable-stat"
                  style={{ padding: '16px 18px' }}
                  onClick={() => openDrilldown(metric)}
                  title={`View the records behind ${label}`}
                >
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
            {(cfg) => (
              <PieCardBody
                data={byTrade}
                height={cfg.chartHeight}
                colorFor={tradeColor}
                onSliceClick={(name) => openDrilldown('byTrade', { category: name })}
              />
            )}
          </AdjustableSection>

          <AdjustableSection id="bySourcePie" title="Leads by referral source" defaultSize="md" layout={layout}>
            {(cfg) => (
              <PieCardBody data={bySourcePie} height={cfg.chartHeight} onSliceClick={(name) => openDrilldown('bySource', { category: name })} />
            )}
          </AdjustableSection>

          <AdjustableSection id="bySourceStack" title="Leads by source — booked vs not" defaultSize="md" layout={layout}>
            {(cfg) => (
              <ResponsiveContainer width="100%" height={cfg.chartHeight}>
                <BarChart data={bySourceStack}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" stroke="var(--ink-muted)" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                  <Tooltip cursor={{ fill: 'var(--surface-2)' }} />
                  <Legend />
                  <Bar
                    dataKey="Booked"
                    stackId="a"
                    fill="var(--chart-green)"
                    style={{ cursor: 'pointer' }}
                    onClick={(entry) => openDrilldown('bySourceStack', { category: entry.name, segment: 'Booked' })}
                  />
                  <Bar
                    dataKey="Not booked"
                    stackId="a"
                    fill="var(--chart-orange)"
                    style={{ cursor: 'pointer' }}
                    onClick={(entry) => openDrilldown('bySourceStack', { category: entry.name, segment: 'Not booked' })}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </AdjustableSection>

          <AdjustableSection id="notBookedReasons" title="Why leads aren't booking" defaultSize="md" layout={layout}>
            {(cfg) => (
              <BarCardBody
                data={notBookedReasons}
                color="var(--chart-orange)"
                height={cfg.chartHeight}
                onBarClick={(name) => openDrilldown('notBookedReason', { category: name })}
              />
            )}
          </AdjustableSection>

          <AdjustableSection id="newCancelReasons" title="New Job Cancellation reasons" defaultSize="md" layout={layout}>
            {(cfg) => (
              <BarCardBody
                data={newCancelReasons}
                color="var(--chart-magenta)"
                height={cfg.chartHeight}
                onBarClick={(name) => openDrilldown('newCancelReason', { category: name })}
              />
            )}
          </AdjustableSection>

          <AdjustableSection id="pendingCancelReasons" title="Pending Cancellation reasons" defaultSize="md" layout={layout}>
            {(cfg) => (
              <BarCardBody
                data={pendingCancelReasons}
                color="var(--chart-violet)"
                height={cfg.chartHeight}
                onBarClick={(name) => openDrilldown('pendingCancelReason', { category: name })}
              />
            )}
          </AdjustableSection>

          <AdjustableSection id="trend" title="Calls over time" defaultSize="lg" layout={layout}>
            {(cfg) => (
              <ResponsiveContainer width="100%" height={cfg.chartHeight}>
                <LineChart data={trend}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" stroke="var(--ink-muted)" fontSize={11} />
                  <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" stroke="var(--chart-teal)" strokeWidth={2} dot={false} />
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
                        {[
                          ['total', s.total],
                          ['inbound', s.inbound],
                          ['outbound', s.outbound],
                          ['textMessage', s.textMessage],
                          ['email', s.email],
                          ['otherContact', s.otherContact],
                          ['leads', s.leads],
                          ['booked', s.booked],
                        ].map(([field, val]) => (
                          <td
                            key={field}
                            className="clickable-stat"
                            onClick={() => openDrilldown('staff', { staffName: s.name, field })}
                            title={`View ${s.name}'s records behind this figure`}
                          >
                            {val}
                          </td>
                        ))}
                        <td
                          className="clickable-stat"
                          onClick={() => openDrilldown('staff', { staffName: s.name, field: 'bookingRate' })}
                          title={`View ${s.name}'s records behind this figure`}
                        >
                          {s.rate}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdjustableSection>
        </div>
      )}

      {drilldown && <DrilldownModal kind="calls" params={drilldown} jumpToJN={jumpToJN} onClose={() => setDrilldown(null)} />}
    </div>
  );
}
