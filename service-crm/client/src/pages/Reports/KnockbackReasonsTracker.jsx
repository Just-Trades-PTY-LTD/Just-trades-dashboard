import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useSessionState } from '../../lib/useSessionState.js';
import { DateField, FilterSelect } from '../../components/Fields.jsx';
import { BarCardBody } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

function defaultFilters() {
  return { from: '', to: '', technicianId: '', tradeId: '', reasonId: '' };
}

// Its own, self-contained report box — deliberately separate from the
// Technician & Sales report's own filters above (and never shown as a column
// in the By Technician table): defaults to the whole company with no date
// restriction, rather than inheriting whatever's currently applied up there.
// Updates live on every filter change — no separate "Refresh Report" step,
// unlike the main report, since this is cheap to recompute and the whole
// point is fast back-and-forth between "whole company" and one technician.
//
// Counts the exact same "genuine Actual Knockback" population as the
// Actual Knockbacks figure above (see services/reports.js's
// computeKnockbackReasonsReport/genuineKnockbackJobs) — a knock-back keeps
// its original reason here even once its quote is later approved, since
// that's a separate Converted Later credit, never another knock-back.
export default function KnockbackReasonsTracker({ layout, setDrilldown }) {
  const settings = useSettings();
  const [filters, setFilters] = useSessionState('crm.reports.tech.knockbackReasons.filters', defaultFilters);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.reports.knockbackReasons(filters).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, [filters]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  // This box's drill-down always carries ITS OWN current filters — never the
  // Technician & Sales report's `applied` filters above, since the two are
  // entirely independent.
  function openReasonDrilldown(reasonName) {
    setDrilldown({
      from: filters.from,
      to: filters.to,
      technicianId: filters.technicianId,
      tradeId: filters.tradeId,
      metric: 'knockbackByReason',
      category: reasonName,
    });
  }

  const chartData = (data?.byReason || []).map((r) => ({ name: r.name, value: r.count }));

  return (
    <AdjustableSection id="knockbackReasons" title="Knockback Reasons" defaultSize="lg" layout={layout}>
      {(cfg) => (
        <div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <DateField label="From" value={filters.from} onChange={(v) => patch({ from: v })} />
            <DateField label="To" value={filters.to} onChange={(v) => patch({ to: v })} />
            <FilterSelect
              label="Technician"
              value={filters.technicianId}
              onChange={(v) => patch({ technicianId: v })}
              options={withInactiveLabel(settings.technicians)}
            />
            <FilterSelect label="Trade" value={filters.tradeId} onChange={(v) => patch({ tradeId: v })} options={settings.trades} />
            <FilterSelect
              label="Reason"
              value={filters.reasonId}
              onChange={(v) => patch({ reasonId: v })}
              options={settings.lists.knockback_reason}
            />
            <button className="btn" type="button" onClick={() => setFilters(defaultFilters())}>
              Clear filters
            </button>
          </div>

          <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14 }}>
            Why jobs are being knocked back — defaults to the whole company; filter down to one technician to spot patterns worth coaching on.
          </div>

          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : !data || data.total === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>
              No knock-backs match these filters yet.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 10 }}>
                {data.total} knock-back{data.total === 1 ? '' : 's'} total
              </div>
              <BarCardBody data={chartData} color="var(--chart-orange)" height={cfg.chartHeight} onBarClick={(name) => openReasonDrilldown(name)} />
              <div className="table-scroll" style={{ marginTop: 14 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Count</th>
                      <th>% of knock-backs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byReason.map((r) => (
                      <tr key={r.name}>
                        <td className="clickable-stat" onClick={() => openReasonDrilldown(r.name)} title={`View the knock-back records behind ${r.name}`}>
                          {r.name}
                        </td>
                        <td className="clickable-stat" onClick={() => openReasonDrilldown(r.name)}>
                          {r.count}
                        </td>
                        <td className="clickable-stat" onClick={() => openReasonDrilldown(r.name)}>
                          {r.percent}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </AdjustableSection>
  );
}
