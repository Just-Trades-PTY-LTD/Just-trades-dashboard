import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { money } from '../../lib/dates.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { PieCardBody, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';

function emptyFilters() {
  return { from: '', to: '', technicianId: '', tradeId: '' };
}

// Cents matter for this one figure (it's a per-job average, rarely a round
// number) — used only in the single KPI card, which has room for it. The
// denser by-trade/by-technician tables below keep whole-dollar money() to
// avoid crowding an already wide row of columns.
function moneyCents(v) {
  return `$${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TechReport() {
  const settings = useSettings();
  const [filters, setFilters] = useState(emptyFilters());
  const [granularity, setGranularity] = useState('week');
  const [data, setData] = useState(null);
  const layout = useReportLayout('tech');

  useEffect(() => {
    api.reports.tech({ ...filters, granularity }).then(setData);
  }, [filters, granularity]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend } = data;

  const kpiRows = [
    // Total Jobs and Qualified Jobs lead the row, immediately next to each
    // other; Unqualified Jobs appears later with the remaining figures.
    // Knock-back rate, conversion rate and average sale are all scoped to
    // qualified jobs only — an unqualified job is never a knock-back.
    ['Total Jobs', company.jobsAttended],
    ['Qualified Jobs', company.qualifiedJobs],
    ['Total sale value (ex GST)', money(company.totalSaleExGst)],
    ['Average sale (ex GST)', moneyCents(company.avgSaleExGst)],
    ['Knock backs', company.knockbacks],
    ['Conversion rate', `${company.conversionRate}%`],
    ['Knock-back rate', `${company.knockbackRate}%`],
    ['Converted later', company.convertedLaterCount],
    ['Sales (invoices)', company.sales],
    ['Unqualified Jobs', company.unqualifiedJobs],
    ['Call backs', company.callBacks],
    ['Pending cancellations', company.pendingCancellations],
    ['Inspection sheet completion', `${company.inspectionRate}%`],
    ['Option sheet completion', `${company.optionRate}%`],
  ];

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
        <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
        <FilterSelect label="Technician" value={filters.technicianId} onChange={(v) => patch({ technicianId: v })} options={settings.technicians} />
        <FilterSelect label="Trade" value={filters.tradeId} onChange={(v) => patch({ tradeId: v })} options={settings.trades} />
        <button className="btn" type="button" onClick={() => setFilters(emptyFilters())}>
          Clear filters
        </button>
        <a className="btn btn-primary" href={api.reports.techXlsxUrl(filters)} style={{ marginLeft: 'auto' }}>
          Export to Excel
        </a>
      </div>

      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Jobs, leads, knock-backs and call backs are dated by visit date. Sales are dated by invoice creation date. Conversion and
        knock-back figures reflect each job's <em>current</em> status, including quotes approved after the visit — re-running a
        report for a past period can show different numbers than when it was first generated.
      </div>

      <div style={{ marginBottom: 20 }}>
        <AdjustableSection id="kpis" title="Summary figures" defaultSize="md" layout={layout}>
          {(cfg) => (
            <div className="grid-cards" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.kpiMinCardWidth}px, 1fr))` }}>
              {kpiRows.map(([label, val]) => (
                <div key={label} className="panel" style={{ padding: '14px 16px' }}>
                  <div className="kpi-val" style={{ fontSize: 21 }}>
                    {val}
                  </div>
                  <div className="kpi-label">{label}</div>
                </div>
              ))}
            </div>
          )}
        </AdjustableSection>
      </div>

      <div className="grid-charts">
        <AdjustableSection id="salesByTradePie" title="Sale value by trade (ex GST)" defaultSize="md" layout={layout}>
          {(cfg) => <PieCardBody data={salesByTradePie} formatValue={money} height={cfg.chartHeight} />}
        </AdjustableSection>

        <AdjustableSection id="jobsOppSalesByTrade" title="Jobs, qualified leads & sales by trade" defaultSize="md" layout={layout}>
          {(cfg) => (
            <ResponsiveContainer width="100%" height={cfg.chartHeight}>
              <BarChart data={jobsOppSalesByTrade}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--ink-muted)" fontSize={11} />
                <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Jobs" fill="#1b75ba" />
                <Bar dataKey="Qualified leads" fill="#c9a227" />
                <Bar dataKey="Sales" fill="#1f7a52" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </AdjustableSection>

        <AdjustableSection
          id="trend"
          title="Sales over time (ex GST)"
          defaultSize="lg"
          layout={layout}
          headerRight={
            <select className="btn" style={{ padding: '4px 10px' }} value={granularity} onChange={(e) => setGranularity(e.target.value)}>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
          }
        >
          {(cfg) => (
            <ResponsiveContainer width="100%" height={cfg.chartHeight}>
              <LineChart data={trend}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="period" stroke="var(--ink-muted)" fontSize={11} />
                <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => money(v)} />
                <Line type="monotone" dataKey="value" stroke="#1b75ba" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </AdjustableSection>

        <AdjustableSection id="byTrade" title="By trade" defaultSize="lg" layout={layout}>
          {(cfg) => (
            <div className="table-scroll" style={cfg.tableMaxHeight ? { maxHeight: cfg.tableMaxHeight, overflowY: 'auto' } : undefined}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Jobs</th>
                    <th>Value (ex GST)</th>
                    <th>Avg sale</th>
                    <th>Knock backs</th>
                    <th>Converted later</th>
                    <th>Conversion %</th>
                    <th>Qual. leads</th>
                    <th>Knock-back %</th>
                    <th>Sales</th>
                    <th>Call backs</th>
                    <th>Pending cancel.</th>
                  </tr>
                </thead>
                <tbody>
                  {byTrade.map((r) => (
                    <tr key={r.trade}>
                      <td>{r.trade}</td>
                      <td>{r.jobsAttended}</td>
                      <td>{money(r.totalSaleExGst)}</td>
                      <td>{money(r.avgSaleExGst)}</td>
                      <td>{r.knockbacks}</td>
                      <td>{r.convertedLaterCount}</td>
                      <td>{r.conversionRate}%</td>
                      <td>{r.qualifiedJobs}</td>
                      <td>{r.knockbackRate}%</td>
                      <td>{r.sales}</td>
                      <td>{r.callBacks}</td>
                      <td>{r.pendingCancellations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdjustableSection>

        <AdjustableSection id="byTechnician" title="By technician" defaultSize="lg" layout={layout}>
          {(cfg) => (
            <div className="table-scroll" style={cfg.tableMaxHeight ? { maxHeight: cfg.tableMaxHeight, overflowY: 'auto' } : undefined}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Technician</th>
                    <th>Total Jobs</th>
                    <th>Qualified Jobs</th>
                    <th>Value (ex GST)</th>
                    <th>Avg sale</th>
                    <th>Knock backs</th>
                    <th>Converted later</th>
                    <th>Conversion %</th>
                    <th>Knock-back %</th>
                    <th>Sales</th>
                    <th>Unqualified Jobs</th>
                    <th>Call backs</th>
                    <th>Pending cancel.</th>
                    <th>Insp. sheet</th>
                    <th>Option sheet</th>
                  </tr>
                </thead>
                <tbody>
                  {byTechnician.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>{r.jobsAttended}</td>
                      <td>{r.qualifiedJobs}</td>
                      <td>{money(r.totalSaleExGst)}</td>
                      <td>{money(r.avgSaleExGst)}</td>
                      <td>{r.knockbacks}</td>
                      <td>{r.convertedLaterCount}</td>
                      <td>{r.conversionRate}%</td>
                      <td>{r.knockbackRate}%</td>
                      <td>{r.sales}</td>
                      <td>{r.unqualifiedJobs}</td>
                      <td>{r.callBacks}</td>
                      <td>{r.pendingCancellations}</td>
                      <td>{r.inspectionRate}%</td>
                      <td>{r.optionRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdjustableSection>
      </div>
    </div>
  );
}
