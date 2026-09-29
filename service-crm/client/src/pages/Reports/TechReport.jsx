import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { useReportFilters } from '../../lib/useReportFilters.js';
import { money, currentAdelaideWeek } from '../../lib/dates.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { PieCardBody, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, tradeColor } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import DrilldownModal from '../../components/DrilldownModal.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

function defaultFilters() {
  return { ...currentAdelaideWeek(), technicianId: '', tradeId: '' };
}

// Cents matter for this one figure (it's a per-job average, rarely a round
// number) — used only in the single KPI card, which has room for it. The
// denser by-trade/by-technician tables below keep whole-dollar money() to
// avoid crowding an already wide row of columns.
function moneyCents(v) {
  return `$${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TechReport({ jumpToJN, drilldown, setDrilldown }) {
  const settings = useSettings();
  const { draft, applied, patch, error, refresh, reset } = useReportFilters(defaultFilters, 'crm.reports.tech.filters');
  const [granularity, setGranularity] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const layout = useReportLayout('tech');

  useEffect(() => {
    setLoading(true);
    api.reports.tech({ ...applied, granularity }).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, [applied, granularity]);

  // Every clickable figure/chart section opens the same modal against the
  // /reports/tech/drilldown endpoint, carrying this report's own currently
  // *applied* filters (from/to/technician/trade) plus whichever selector
  // that figure needs — see services/reports.js's drilldownTech().
  function openDrilldown(metric, extra) {
    setDrilldown({ from: applied.from, to: applied.to, technicianId: applied.technicianId, tradeId: applied.tradeId, metric, ...extra });
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend } = data;

  // Converted Later bonus adjustment (trial) — entirely additive report
  // figures, computed fresh on every report run; see services/reports.js.
  // Kept in its own KPI row, table columns and chart rather than folded into
  // the figures above, so the two can never be mistaken for each other and
  // this trial can be removed later by deleting this section alone.
  const bonusKpiRows = [
    ['Actual Knockbacks', company.actualKnockbacks, 'actualKnockbacks'],
    ['Converted Later', company.convertedLaterCredits, 'convertedLaterCredits'],
    ['Adjusted Knockbacks', company.adjustedKnockbacks, 'adjustedKnockbacks'],
    ['Conversion Rate (bonus)', `${(company.bonusConversionRate ?? 0).toFixed(2)}%`, 'bonusConversionRate'],
  ];
  const knockbackAdjustmentByTechnician = byTechnician
    .filter((r) => r.actualKnockbacks > 0 || r.convertedLaterCredits > 0)
    .map((r) => ({
      name: r.name,
      'Actual Knockbacks': r.actualKnockbacks,
      'Converted Later': r.convertedLaterCredits,
      'Adjusted Knockbacks': r.adjustedKnockbacks,
    }));

  const kpiRows = [
    // Total Jobs and Qualified Jobs lead the row, immediately next to each
    // other; Unqualified Jobs appears later with the remaining figures.
    // Conversion rate and average sale are both scoped to qualified jobs
    // only — an unqualified job is never a knock-back. Knock-back rate is
    // deliberately not shown here (or anywhere in this report) — only the
    // raw Knock backs count — while still being computed and available via
    // the API for anything that needs it.
    ['Total Jobs', company.jobsAttended, 'jobsAttended'],
    ['Qualified Jobs', company.qualifiedJobs, 'qualifiedJobs'],
    ['Total sale value (ex GST)', money(company.totalSaleExGst), 'totalSaleExGst'],
    ['Average sale (ex GST)', moneyCents(company.avgSaleExGst), 'avgSaleExGst'],
    ['Knock backs', company.knockbacks, 'knockbacks'],
    ['Conversion rate', `${company.conversionRate}%`, 'conversionRate'],
    ['Converted later', company.convertedLaterCount, 'convertedLaterCount'],
    ['Sales (invoices)', company.sales, 'sales'],
    ['Unqualified Jobs', company.unqualifiedJobs, 'unqualifiedJobs'],
    ['Call backs', company.callBacks, 'callBacks'],
    ['Pending cancellations', company.pendingCancellations, 'pendingCancellations'],
    ['Inspection sheet completion', `${company.inspectionRate}%`, 'inspectionRate'],
    ['Option sheet completion', `${company.optionRate}%`, 'optionRate'],
  ];

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={draft.from} onChange={(v) => patch({ from: v })} invalid={!!error} />
        <DateField label="To" value={draft.to} onChange={(v) => patch({ to: v })} invalid={!!error} />
        <FilterSelect
          label="Technician"
          value={draft.technicianId}
          onChange={(v) => patch({ technicianId: v })}
          options={withInactiveLabel(settings.technicians)}
        />
        <FilterSelect label="Trade" value={draft.tradeId} onChange={(v) => patch({ tradeId: v })} options={settings.trades} />
        <button className="btn btn-primary" type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh Report'}
        </button>
        <button className="btn" type="button" onClick={reset}>
          Reset Filters
        </button>
        <a className="btn btn-primary" href={api.reports.techXlsxUrl(applied)} style={{ marginLeft: 'auto' }}>
          Export to Excel
        </a>
      </div>

      {error && (
        <div className="notice panel error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Jobs, leads, knock-backs and call backs are dated by visit date. Sales are dated by invoice creation date. Conversion and
        knock-back figures reflect each job's <em>current</em> status, including quotes approved after the visit — re-running a
        report for a past period can show different numbers than when it was first generated.
      </div>

      <div style={{ marginBottom: 20 }}>
        <AdjustableSection id="kpis" title="Summary figures" defaultSize="md" layout={layout}>
          {(cfg) => (
            <div className="grid-cards" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.kpiMinCardWidth}px, 1fr))` }}>
              {kpiRows.map(([label, val, metric]) => (
                <div
                  key={label}
                  className="panel clickable-stat"
                  style={{ padding: '14px 16px' }}
                  onClick={() => openDrilldown(metric)}
                  title={`View the records behind ${label}`}
                >
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

      <div style={{ marginBottom: 20 }}>
        <AdjustableSection id="convertedLaterBonus" title="Converted Later Bonus Adjustment (Trial)" defaultSize="md" layout={layout}>
          {(cfg) => (
            <div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
                Trial figures only — report logic, not saved data. Each Converted Later sale credits one Actual Knockback for
                the same technician within the same Monday–Sunday week; unused credits expire at the end of that week. This
                never changes the Knock backs / Converted later / Conversion rate figures above, and can be removed later
                without affecting any saved record.
              </div>
              <div className="grid-cards" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.kpiMinCardWidth}px, 1fr))` }}>
                {bonusKpiRows.map(([label, val, metric]) => (
                  <div
                    key={label}
                    className="panel clickable-stat"
                    style={{ padding: '14px 16px' }}
                    onClick={() => openDrilldown(metric)}
                    title={`View the records behind ${label}`}
                  >
                    <div className="kpi-val" style={{ fontSize: 21 }}>
                      {val}
                    </div>
                    <div className="kpi-label">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </AdjustableSection>
      </div>

      <div className="grid-charts">
        <AdjustableSection id="salesByTradePie" title="Sale value by trade (ex GST)" defaultSize="md" layout={layout}>
          {(cfg) => (
            <PieCardBody
              data={salesByTradePie}
              formatValue={money}
              height={cfg.chartHeight}
              colorFor={tradeColor}
              onSliceClick={(name) => openDrilldown('salesByTradePie', { category: name })}
            />
          )}
        </AdjustableSection>

        <AdjustableSection id="jobsOppSalesByTrade" title="Jobs, qualified leads & sales by trade" defaultSize="md" layout={layout}>
          {(cfg) => (
            <ResponsiveContainer width="100%" height={cfg.chartHeight}>
              <BarChart data={jobsOppSalesByTrade}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--ink-muted)" fontSize={11} />
                <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                <Tooltip cursor={{ fill: 'var(--surface-2)' }} />
                <Legend />
                <Bar
                  dataKey="Jobs"
                  fill="var(--chart-teal)"
                  style={{ cursor: 'pointer' }}
                  onClick={(entry) => openDrilldown('jobsOppSalesByTrade', { category: entry.name, series: 'Jobs' })}
                />
                <Bar
                  dataKey="Qualified leads"
                  fill="var(--chart-orange)"
                  style={{ cursor: 'pointer' }}
                  onClick={(entry) => openDrilldown('jobsOppSalesByTrade', { category: entry.name, series: 'Qualified leads' })}
                />
                <Bar
                  dataKey="Sales"
                  fill="var(--chart-violet)"
                  style={{ cursor: 'pointer' }}
                  onClick={(entry) => openDrilldown('jobsOppSalesByTrade', { category: entry.name, series: 'Sales' })}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </AdjustableSection>

        <AdjustableSection id="knockbackAdjustmentByTechnician" title="Knockbacks: Actual vs Adjusted by Technician (Trial)" defaultSize="md" layout={layout}>
          {(cfg) =>
            knockbackAdjustmentByTechnician.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>
                No Knockbacks or Converted Later credits in this range yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={cfg.chartHeight}>
                <BarChart data={knockbackAdjustmentByTechnician}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" stroke="var(--ink-muted)" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
                  <Tooltip cursor={{ fill: 'var(--surface-2)' }} />
                  <Legend />
                  <Bar
                    dataKey="Actual Knockbacks"
                    fill="var(--chart-teal)"
                    style={{ cursor: 'pointer' }}
                    onClick={(entry) => openDrilldown('actualKnockbacks', { scopeTechnician: entry.name })}
                  />
                  <Bar
                    dataKey="Converted Later"
                    fill="var(--chart-orange)"
                    style={{ cursor: 'pointer' }}
                    onClick={(entry) => openDrilldown('convertedLaterCredits', { scopeTechnician: entry.name })}
                  />
                  <Bar
                    dataKey="Adjusted Knockbacks"
                    fill="var(--chart-violet)"
                    style={{ cursor: 'pointer' }}
                    onClick={(entry) => openDrilldown('adjustedKnockbacks', { scopeTechnician: entry.name })}
                  />
                </BarChart>
              </ResponsiveContainer>
            )
          }
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
                <Line type="monotone" dataKey="value" stroke="var(--chart-teal)" strokeWidth={2} dot={{ r: 3 }} />
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
                    <th>Sales</th>
                    <th>Call backs</th>
                    <th>Pending cancel.</th>
                  </tr>
                </thead>
                <tbody>
                  {byTrade.map((r) => (
                    <tr key={r.trade}>
                      <td>
                        <span className="trade-label">
                          <span className="trade-swatch" style={{ background: tradeColor(r.trade) }} />
                          {r.trade}
                        </span>
                      </td>
                      {[
                        ['jobsAttended', r.jobsAttended],
                        ['totalSaleExGst', money(r.totalSaleExGst)],
                        ['avgSaleExGst', money(r.avgSaleExGst)],
                        ['knockbacks', r.knockbacks],
                        ['convertedLaterCount', r.convertedLaterCount],
                        ['conversionRate', `${r.conversionRate}%`],
                        ['qualifiedJobs', r.qualifiedJobs],
                        ['sales', r.sales],
                        ['callBacks', r.callBacks],
                        ['pendingCancellations', r.pendingCancellations],
                      ].map(([field, val]) => (
                        <td
                          key={field}
                          className="clickable-stat"
                          onClick={() => openDrilldown(field, { scopeTrade: r.trade })}
                          title={`View ${r.trade}'s records behind this figure`}
                        >
                          {val}
                        </td>
                      ))}
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
                    <th>Sales</th>
                    <th>Unqualified Jobs</th>
                    <th>Call backs</th>
                    <th>Pending cancel.</th>
                    <th>Insp. sheet</th>
                    <th>Option sheet</th>
                    <th title="Trial: report logic only, see the Converted Later Bonus Adjustment section above">Actual Knockbacks</th>
                    <th title="Trial: report logic only, see the Converted Later Bonus Adjustment section above">Converted Later</th>
                    <th title="Trial: report logic only, see the Converted Later Bonus Adjustment section above">Adjusted Knockbacks</th>
                    <th title="Trial: report logic only, see the Converted Later Bonus Adjustment section above">Conversion % (bonus)</th>
                  </tr>
                </thead>
                <tbody>
                  {byTechnician.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      {[
                        ['jobsAttended', r.jobsAttended],
                        ['qualifiedJobs', r.qualifiedJobs],
                        ['totalSaleExGst', money(r.totalSaleExGst)],
                        ['avgSaleExGst', money(r.avgSaleExGst)],
                        ['knockbacks', r.knockbacks],
                        ['convertedLaterCount', r.convertedLaterCount],
                        ['conversionRate', `${r.conversionRate}%`],
                        ['sales', r.sales],
                        ['unqualifiedJobs', r.unqualifiedJobs],
                        ['callBacks', r.callBacks],
                        ['pendingCancellations', r.pendingCancellations],
                        ['inspectionRate', `${r.inspectionRate}%`],
                        ['optionRate', `${r.optionRate}%`],
                        ['actualKnockbacks', r.actualKnockbacks],
                        ['convertedLaterCredits', r.convertedLaterCredits],
                        ['adjustedKnockbacks', r.adjustedKnockbacks],
                        ['bonusConversionRate', `${(r.bonusConversionRate ?? 0).toFixed(2)}%`],
                      ].map(([field, val]) => (
                        <td
                          key={field}
                          className="clickable-stat"
                          onClick={() => openDrilldown(field, { scopeTechnician: r.name })}
                          title={`View ${r.name}'s records behind this figure`}
                        >
                          {val}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdjustableSection>
      </div>

      {drilldown && <DrilldownModal kind="tech" params={drilldown} jumpToJN={jumpToJN} onClose={() => window.history.back()} />}
    </div>
  );
}
