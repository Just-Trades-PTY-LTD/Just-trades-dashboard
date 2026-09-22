import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { money } from '../../lib/dates.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { ChartPanel, PieCard, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from '../../components/Charts.jsx';

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

  useEffect(() => {
    api.reports.tech({ ...filters, granularity }).then(setData);
  }, [filters, granularity]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  if (!data) return <div className="empty-state">Loading…</div>;
  const { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend } = data;

  const kpiRows = [
    // Headline figures first, in the order requested — everything else
    // follows in its previous relative order.
    ['Jobs attended', company.jobsAttended],
    ['Total sale value (ex GST)', money(company.totalSaleExGst)],
    ['Average sale (ex GST)', moneyCents(company.avgSaleExGst)],
    ['Knock backs', company.knockbacks],
    ['Conversion rate', `${company.conversionRate}%`],
    ['Qualified leads', company.qualifiedLeads],
    ['Knock-back rate', `${company.knockbackRate}%`],
    ['Converted later', company.convertedLaterCount],
    ['Sales (invoices)', company.sales],
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
      </div>

      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Jobs, leads, knock-backs and call backs are dated by visit date. Sales are dated by invoice creation date. Conversion and
        knock-back figures reflect each job's <em>current</em> status, including quotes approved after the visit — re-running a
        report for a past period can show different numbers than when it was first generated.
      </div>

      <div className="grid-cards" style={{ marginBottom: 20 }}>
        {kpiRows.map(([label, val]) => (
          <div key={label} className="panel" style={{ padding: '14px 16px' }}>
            <div className="kpi-val" style={{ fontSize: 21 }}>
              {val}
            </div>
            <div className="kpi-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid-charts">
        <PieCard title="Sale value by trade (ex GST)" data={salesByTradePie} formatValue={money} />
        <ChartPanel title="Jobs, qualified leads & sales by trade">
          <ResponsiveContainer width="100%" height={220}>
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
        </ChartPanel>
        <ChartPanel
          title="Sales over time (ex GST)"
          span2
          headerRight={
            <select className="btn" style={{ padding: '4px 10px' }} value={granularity} onChange={(e) => setGranularity(e.target.value)}>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="period" stroke="var(--ink-muted)" fontSize={11} />
              <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => money(v)} />
              <Line type="monotone" dataKey="value" stroke="#1b75ba" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartPanel>

        <ChartPanel title="By trade" span2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Trade</th>
                  <th>Jobs</th>
                  <th>Qual. leads</th>
                  <th>Knock backs</th>
                  <th>Knock-back %</th>
                  <th>Converted later</th>
                  <th>Conversion %</th>
                  <th>Sales</th>
                  <th>Value (ex GST)</th>
                  <th>Avg sale</th>
                  <th>Call backs</th>
                  <th>Pending cancel.</th>
                </tr>
              </thead>
              <tbody>
                {byTrade.map((r) => (
                  <tr key={r.trade}>
                    <td>{r.trade}</td>
                    <td>{r.jobsAttended}</td>
                    <td>{r.qualifiedLeads}</td>
                    <td>{r.knockbacks}</td>
                    <td>{r.knockbackRate}%</td>
                    <td>{r.convertedLaterCount}</td>
                    <td>{r.conversionRate}%</td>
                    <td>{r.sales}</td>
                    <td>{money(r.totalSaleExGst)}</td>
                    <td>{money(r.avgSaleExGst)}</td>
                    <td>{r.callBacks}</td>
                    <td>{r.pendingCancellations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartPanel>

        <ChartPanel title="By technician" span2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Jobs</th>
                  <th>Qual. leads</th>
                  <th>Knock backs</th>
                  <th>Knock-back %</th>
                  <th>Converted later</th>
                  <th>Conversion %</th>
                  <th>Sales</th>
                  <th>Value (ex GST)</th>
                  <th>Avg sale</th>
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
                    <td>{r.qualifiedLeads}</td>
                    <td>{r.knockbacks}</td>
                    <td>{r.knockbackRate}%</td>
                    <td>{r.convertedLaterCount}</td>
                    <td>{r.conversionRate}%</td>
                    <td>{r.sales}</td>
                    <td>{money(r.totalSaleExGst)}</td>
                    <td>{money(r.avgSaleExGst)}</td>
                    <td>{r.callBacks}</td>
                    <td>{r.pendingCancellations}</td>
                    <td>{r.inspectionRate}%</td>
                    <td>{r.optionRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartPanel>
      </div>
    </div>
  );
}
