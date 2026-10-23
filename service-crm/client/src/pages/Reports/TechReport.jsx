import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { useReportFilters } from '../../lib/useReportFilters.js';
import { money, currentAdelaideWeek, DATE_RANGE_PRESETS, matchDateRangePreset } from '../../lib/dates.js';
import { DateField, FilterSelect, DateRangePresetSelect, TextField, AdvancedFiltersToggle } from '../../components/Fields.jsx';
import { PieCardBody, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, tradeColor } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import DrilldownModal from '../../components/DrilldownModal.jsx';
import KnockbackReasonsTracker, { defaultKnockbackReasonsFilters } from './KnockbackReasonsTracker.jsx';
import { useSessionState } from '../../lib/useSessionState.js';
import { withInactiveLabel } from '../../lib/activeOptions.js';

const YES_NO = ['Yes', 'No'];
const ENTRY_TYPES = [
  { id: 'new_job_no_sale', name: 'New Job — No Sale' },
  { id: 'new_job_sale_made', name: 'New Job — Sale Made' },
  { id: 'quote_approved_later', name: 'Existing Job — Quote Approved Later' },
  { id: 'existing_job_upsell', name: 'Existing Job — Upsell' },
  { id: 'call_back', name: 'Call Back' },
  { id: 'pending_cancellation', name: 'Pending Cancellation' },
];
// "Unassigned" is a real, selectable state wherever the underlying field can
// genuinely be blank — a legacy job saved before Lead was required, never
// silently folded into "All". See services/reports.js's matchesTextOrUnassigned().
const LEAD_QUALIFICATION_OPTIONS = [
  { id: 'unassigned', name: 'Unassigned' },
  { id: 'Qualified', name: 'Qualified' },
  { id: 'Not Qualified', name: 'Not Qualified' },
];
function withUnassigned(list) {
  return [{ id: 'unassigned', name: 'Unassigned' }, ...list];
}

// Every Advanced Filters field, blank by default. Knockback Reason stays
// inside the already-independent Knockback Reasons tracker box rather than
// becoming a new filter here — see that component's own reasonId filter.
// Inspection Sheet, Option Sheet and Work Completion are deliberately not
// offered as filters at all: none of them can be reliably propagated to
// Sales/Upsells/Call Backs/Pending Cancellations (a sale has no Inspection
// Sheet status of its own), so filtering Jobs by one of these while leaving
// those other figures untouched would make Total Sales Value/Conversion %
// misleading — narrowed Jobs sitting alongside an unfiltered Sales total.
// The Inspection/Option Sheet completion-rate figures themselves are
// unaffected by this and still work exactly as before.
const EMPTY_ADVANCED = {
  saleMade: '',
  knockback: '',
  convertedLater: '',
  entryType: '',
  suburb: '',
  jobNumber: '',
  createdByUserId: '',
  lastEditedByUserId: '',
};

function defaultFilters() {
  return {
    ...currentAdelaideWeek(),
    technicianId: '',
    tradeId: '',
    jobTypeId: '',
    leadQualification: '',
    leadSourceId: '',
    ...EMPTY_ADVANCED,
  };
}

// Inspection/Option Sheet completion can be null (no Yes/No records at all —
// every job in scope was N/A or never answered) — shown as "—", never a
// misleading 0%. See the server's services/reports.js's yesNoRate().
function rateLabel(v) {
  return v == null ? '—' : `${v}%`;
}

export default function TechReport({ jumpToJN, jumpToJobId, drilldown, setDrilldown }) {
  const settings = useSettings();
  const { draft, applied, patch, error, refresh, reset } = useReportFilters(defaultFilters, 'crm.reports.tech.filters');
  const [granularity, setGranularity] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const layout = useReportLayout('tech');
  // Owned here (not inside KnockbackReasonsTracker) purely so the "Export to
  // Excel" link below can carry this box's own current filters alongside the
  // report's own — see techXlsxUrl() just below and buildTechWorkbook() on
  // the server, which reads them back out of the same kbr-prefixed params.
  const [knockbackReasonsFilters, setKnockbackReasonsFilters] = useSessionState(
    'crm.reports.tech.knockbackReasons.filters',
    defaultKnockbackReasonsFilters
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedActiveCount = Object.keys(EMPTY_ADVANCED).filter((k) => applied[k] && applied[k] !== '').length;

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
    setDrilldown({ ...applied, metric, ...extra });
  }

  // Positive Reviews is a genuinely separate figure from everything else on
  // this report (see services/reports.js's positiveReviewsByTechnicianName)
  // — its drill-down opens the Reviews kind of modal (review records, not
  // job-entry records), carrying only this report's own from/to/technicianId
  // (reviews have no trade/job type), never the Trade/Job Type filters.
  function openReviewsDrilldown(technicianName) {
    setDrilldown({
      from: applied.from,
      to: applied.to,
      technicianId: applied.technicianId,
      metric: 'positiveReviewsByTechnician',
      scopeTechnician: technicianName,
      kind: 'reviews',
    });
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { company, byTrade, byTechnician, salesByTradePie, jobsOppSalesByTrade, trend, missingTechnicianCount } = data;

  // Converted Later bonus adjustment — computed fresh on every
  // report run from the underlying jobs/sales (see services/reports.js).
  // These figures replace the old Knock backs / Converted later / Conversion
  // rate cards in place (renamed, same single card each) rather than adding
  // a second, duplicate set — only Adjusted Knockbacks is genuinely new.
  const knockbackAdjustmentByTechnician = byTechnician
    .filter((r) => r.actualKnockbacks > 0 || r.convertedLaterCredits > 0)
    .map((r) => ({
      name: r.name,
      'Actual Knockbacks': r.actualKnockbacks,
      'Converted Later': r.convertedLaterCredits,
      'Adjusted Knockbacks': r.adjustedKnockbacks,
    }));

  // Adjusted Knockbacks and Conversion % are purely calculated (Actual
  // Knockbacks − Converted Later, and the conversion rate derived from that)
  // — neither represents its own distinct group of records, so neither is
  // clickable. A `tooltip` in place of a metric name means "show this
  // explanation instead of opening a drill-down".
  const kpiRows = [
    // Total Jobs and Qualified Jobs lead the row, immediately next to each
    // other; Unqualified Jobs appears later with the remaining figures.
    // Sales / Converted Later / Actual Knockbacks / Adjusted Knockbacks /
    // Conversion % are grouped together as one cluster of "main performance
    // figures" — each appears exactly once. Actual Knockbacks and Conversion
    // % replace the old, differently-scoped Knock backs / Conversion rate
    // cards in place; Adjusted Knockbacks is the only genuinely new figure.
    ['Total Jobs', company.jobsAttended, 'jobsAttended'],
    ['Qualified Jobs', company.qualifiedJobs, 'qualifiedJobs'],
    ['Sales (invoices)', company.sales, 'sales'],
    ['Converted Later', company.convertedLaterCredits, 'convertedLaterCredits'],
    ['Actual Knockbacks', company.actualKnockbacks, 'actualKnockbacks'],
    ['Adjusted Knockbacks', company.adjustedKnockbacks, null, 'Calculated as Actual Knockbacks minus Converted Later.'],
    [
      'Conversion %',
      `${(company.bonusConversionRate ?? 0).toFixed(2)}%`,
      null,
      'Calculated as (Qualified Jobs − Adjusted Knockbacks) ÷ Qualified Jobs.',
    ],
    ['Total sale value (ex GST)', money(company.totalSaleExGst), 'totalSaleExGst'],
    ['Average sale (ex GST)', money(company.avgSaleExGst), 'avgSaleExGst'],
    // Reported separately from Sales/Value above — never folded into either
    // figure's own count, never treated as an attended job or a qualified
    // lead (see services/reports.js's computeMetrics()). Total sale value
    // above already includes Upsell value; Average sale deliberately never
    // does.
    ['Upsells', company.upsellsCount, 'upsellsCount'],
    ['Upsell value (ex GST)', money(company.upsellValueExGst), 'upsellValueExGst'],
    ['Unqualified Jobs', company.unqualifiedJobs, 'unqualifiedJobs'],
    ['Call backs', company.callBacks, 'callBacks'],
    ['Pending cancellations', company.pendingCancellations, 'pendingCancellations'],
    ['Inspection sheet completion', rateLabel(company.inspectionRate), 'inspectionRate'],
    ['Option sheet completion', rateLabel(company.optionRate), 'optionRate'],
  ];

  return (
    <div>
      <div className="panel" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField label="From" value={draft.from} onChange={(v) => patch({ from: v })} invalid={!!error} />
        <DateField label="To" value={draft.to} onChange={(v) => patch({ to: v })} invalid={!!error} />
        <DateRangePresetSelect
          value={matchDateRangePreset(draft.from, draft.to)}
          onChange={(id) => {
            const preset = DATE_RANGE_PRESETS.find((p) => p.id === id);
            if (preset?.range) patch(preset.range());
          }}
          options={DATE_RANGE_PRESETS}
        />
        <FilterSelect
          label="Technician"
          value={draft.technicianId}
          onChange={(v) => patch({ technicianId: v })}
          options={withInactiveLabel(settings.technicians)}
        />
        <FilterSelect
          label="Trade"
          value={draft.tradeId}
          // Changing Trade always resets Job Type back to "All Job Types" —
          // an unrelated job type from a previously-selected trade must
          // never be silently retained.
          onChange={(v) => patch({ tradeId: v, jobTypeId: '' })}
          options={settings.trades}
        />
        <FilterSelect
          label="Job type"
          value={draft.jobTypeId}
          onChange={(v) => patch({ jobTypeId: v })}
          options={draft.tradeId ? settings.jobTypesFor(draft.tradeId) : []}
        />
        <FilterSelect
          label="Lead Qualification"
          value={draft.leadQualification}
          onChange={(v) => patch({ leadQualification: v })}
          options={LEAD_QUALIFICATION_OPTIONS}
        />
        <FilterSelect
          label="Lead Source"
          value={draft.leadSourceId}
          onChange={(v) => patch({ leadSourceId: v })}
          options={withUnassigned(settings.lists.lead_source)}
        />
        <a
          className="btn btn-primary"
          href={api.reports.techXlsxUrl({
            ...applied,
            // The Knockback Reasons tracker's own Trade/Reason filters
            // (kbr-prefixed so they can never collide with or override the
            // report's own above) — see routes/reports.js's /tech.xlsx. Its
            // date range AND technician are deliberately NOT independent:
            // kbrFrom/kbrTo/kbrTechnicianId are always this report's own
            // currently applied from/to/technicianId, exactly like every
            // other section of this export, so the Knockback Reasons sheets
            // can never show a different reporting period or technician
            // from the rest of the workbook.
            kbrFrom: applied.from,
            kbrTo: applied.to,
            kbrTechnicianId: applied.technicianId,
            kbrTradeId: knockbackReasonsFilters.tradeId,
            kbrReasonId: knockbackReasonsFilters.reasonId,
          })}
        >
          Export to Excel
        </a>
        <button className="btn" type="button" onClick={reset}>
          Reset Filters
        </button>
        <AdvancedFiltersToggle open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)} activeCount={advancedActiveCount} />
        {/* Refresh Report is the button used most often, so it always stays
            pinned to the far right of its row — marginLeft: auto here rather
            than on Export to Excel (which moved earlier to make room for the
            Job Type filter) — and still lands on the far right of whichever
            line it wraps to on a narrow screen. */}
        <button className="btn btn-primary" type="button" onClick={refresh} disabled={loading} style={{ marginLeft: 'auto' }}>
          {loading ? 'Refreshing…' : 'Refresh Report'}
        </button>
      </div>

      {advancedOpen && (
        <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Advanced Filters</div>
          <div className="grid-form">
            <FilterSelect label="Sale Made" value={draft.saleMade} onChange={(v) => patch({ saleMade: v })} options={YES_NO} />
            <FilterSelect label="Knockback status" value={draft.knockback} onChange={(v) => patch({ knockback: v })} options={YES_NO} />
            <FilterSelect label="Converted Later" value={draft.convertedLater} onChange={(v) => patch({ convertedLater: v })} options={YES_NO} />
            <FilterSelect label="Entry Type" value={draft.entryType} onChange={(v) => patch({ entryType: v })} options={ENTRY_TYPES} />
            <TextField label="Suburb" value={draft.suburb} onChange={(v) => patch({ suburb: v })} />
            <TextField label="Job Number" value={draft.jobNumber} onChange={(v) => patch({ jobNumber: v })} />
            <FilterSelect
              label="Created By"
              value={draft.createdByUserId}
              onChange={(v) => patch({ createdByUserId: v })}
              options={withInactiveLabel(settings.staffAll)}
            />
            <FilterSelect
              label="Last Edited By"
              value={draft.lastEditedByUserId}
              onChange={(v) => patch({ lastEditedByUserId: v })}
              options={withInactiveLabel(settings.staffAll)}
            />
          </div>
          {draft.entryType && (
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 10 }}>
              With Entry Type set, every figure below reflects only that record type — sections that don't apply to it show
              "Not applicable to this filter" rather than an unchanged-looking zero.
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="notice panel error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {missingTechnicianCount > 0 && (
        <div
          className="notice panel error clickable-stat"
          style={{ marginBottom: 16, cursor: 'pointer' }}
          onClick={() => openDrilldown('missingTechnician')}
          title="View the records with no Technician assigned"
        >
          {missingTechnicianCount} record{missingTechnicianCount > 1 ? 's' : ''} in this range {missingTechnicianCount > 1 ? 'have' : 'has'} no Technician
          assigned and {missingTechnicianCount > 1 ? "aren't" : "isn't"} included in the By Technician table below — click to view and correct{' '}
          {missingTechnicianCount > 1 ? 'them' : 'it'}. The Technician field is mandatory going forward; this can only affect older records.
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
        Jobs, leads, knock-backs and call backs are dated by visit date. Sales are dated by invoice creation date.
        <br />
        <strong>Note:</strong> Actual Knockbacks and Converted Later are each counted by their own date (visit date / invoice
        date), calculated by report logic only — no saved record is ever changed. Adjusted Knockbacks credits one Converted
        Later sale against one Actual Knockback for the same technician within the same Monday–Sunday week — unused credits
        expire at the end of that week. Conversion % is (Qualified Jobs − Adjusted Knockbacks) ÷ Qualified Jobs.
      </div>

      <div style={{ marginBottom: 20 }}>
        <AdjustableSection id="kpis" title="Summary figures" defaultSize="md" layout={layout}>
          {(cfg) => (
            <div className="grid-cards" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cfg.kpiMinCardWidth}px, 1fr))` }}>
              {kpiRows.map(([label, val, metric, tooltip]) => (
                <div
                  key={label}
                  className={`panel${metric ? ' clickable-stat' : ''}`}
                  style={{ padding: '14px 16px' }}
                  onClick={metric ? () => openDrilldown(metric) : undefined}
                  title={metric ? `View the records behind ${label}` : tooltip}
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

        <AdjustableSection id="knockbackAdjustmentByTechnician" title="Knockbacks: Actual vs Adjusted by Technician" defaultSize="md" layout={layout}>
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
                  {/* Adjusted Knockbacks is purely calculated (Actual Knockbacks
                      − Converted Later) — it isn't its own group of records,
                      so this bar isn't clickable, unlike the two beside it. */}
                  <Bar dataKey="Adjusted Knockbacks" fill="var(--chart-violet)" />
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
                    <th>Upsells</th>
                    <th>Upsell Value (ex GST)</th>
                    <th>Call backs</th>
                    <th>Pending cancel.</th>
                    <th>Inspection Sheet %</th>
                    <th>Option Sheet %</th>
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
                        ['upsellsCount', r.upsellsCount],
                        ['upsellValueExGst', money(r.upsellValueExGst)],
                        ['callBacks', r.callBacks],
                        ['pendingCancellations', r.pendingCancellations],
                        ['inspectionRate', rateLabel(r.inspectionRate)],
                        ['optionRate', rateLabel(r.optionRate)],
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
                    <th>Sales</th>
                    <th title="Report logic only — see the note above">Converted Later</th>
                    <th title="Report logic only — see the note above">Actual Knockbacks</th>
                    <th title="Report logic only — see the note above. Calculated as Actual Knockbacks minus Converted Later.">
                      Adjusted Knockbacks
                    </th>
                    <th title="Report logic only — see the note above. Calculated as (Qualified Jobs − Adjusted Knockbacks) ÷ Qualified Jobs.">
                      Conversion %
                    </th>
                    <th>Value (ex GST)</th>
                    <th>Average Sale</th>
                    <th>Upsells</th>
                    <th>Upsell Value (ex GST)</th>
                    <th>Unqualified Jobs</th>
                    <th>Call Backs</th>
                    <th>Pending Cancellations</th>
                    <th>Inspection Sheet %</th>
                    <th>Option Sheet %</th>
                    <th title="Separate from every other figure on this report — see the Reviews area">Positive Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {byTechnician.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      {[
                        ['jobsAttended', r.jobsAttended],
                        ['qualifiedJobs', r.qualifiedJobs],
                        ['sales', r.sales],
                        ['convertedLaterCredits', r.convertedLaterCredits],
                        ['actualKnockbacks', r.actualKnockbacks],
                        // Adjusted Knockbacks and Conversion % are purely
                        // calculated (see the column header tooltips above) —
                        // neither is its own group of records, so neither cell
                        // opens a drill-down.
                        ['adjustedKnockbacks', r.adjustedKnockbacks, 'Calculated as Actual Knockbacks minus Converted Later.'],
                        [
                          'bonusConversionRate',
                          `${(r.bonusConversionRate ?? 0).toFixed(2)}%`,
                          'Calculated as (Qualified Jobs − Adjusted Knockbacks) ÷ Qualified Jobs.',
                        ],
                        ['totalSaleExGst', money(r.totalSaleExGst)],
                        ['avgSaleExGst', money(r.avgSaleExGst)],
                        ['upsellsCount', r.upsellsCount],
                        ['upsellValueExGst', money(r.upsellValueExGst)],
                        ['unqualifiedJobs', r.unqualifiedJobs],
                        ['callBacks', r.callBacks],
                        ['pendingCancellations', r.pendingCancellations],
                        ['inspectionRate', rateLabel(r.inspectionRate)],
                        ['optionRate', rateLabel(r.optionRate)],
                      ].map(([field, val, tooltip]) => (
                        <td
                          key={field}
                          className={tooltip ? undefined : 'clickable-stat'}
                          onClick={tooltip ? undefined : () => openDrilldown(field, { scopeTechnician: r.name })}
                          title={tooltip || `View ${r.name}'s records behind this figure`}
                        >
                          {val}
                        </td>
                      ))}
                      <td
                        className="clickable-stat"
                        onClick={() => openReviewsDrilldown(r.name)}
                        title={`View ${r.name}'s positive review records`}
                      >
                        {r.positiveReviewsCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdjustableSection>

        <KnockbackReasonsTracker
          layout={layout}
          setDrilldown={setDrilldown}
          filters={knockbackReasonsFilters}
          setFilters={setKnockbackReasonsFilters}
          from={applied.from}
          to={applied.to}
          technicianId={applied.technicianId}
          technicianName={withInactiveLabel(settings.technicians).find((t) => String(t.id) === String(applied.technicianId))?.name}
        />
      </div>

      {drilldown && (
        <DrilldownModal
          kind={drilldown.kind || 'tech'}
          params={drilldown}
          jumpToJN={jumpToJN}
          jumpToJobId={jumpToJobId}
          onClose={() => window.history.back()}
        />
      )}
    </div>
  );
}
