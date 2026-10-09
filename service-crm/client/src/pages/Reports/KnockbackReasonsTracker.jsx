import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { FilterSelect } from '../../components/Fields.jsx';
import { BarCardBody } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

export function defaultKnockbackReasonsFilters() {
  return { technicianId: '', tradeId: '', reasonId: '' };
}

// Its own Technician/Trade/Reason filters, but its date range is never its
// own: `from`/`to` always come from the Technician & Sales report's main
// filter bar above (passed down as props, not part of `filters`), so this
// box can never show a different reporting period from the rest of the
// page. Updates live on every filter change (including whenever the main
// report's date range is refreshed) — no separate "Refresh Report" step of
// its own, since this is cheap to recompute and the whole point is fast
// back-and-forth between "whole company" and one technician.
//
// `filters`/`setFilters` are owned by TechReport.jsx (not this component)
// purely so its "Export to Excel" link can carry this box's own current
// Technician/Trade/Reason filters alongside the report's own (from/to
// included) — see that file's techXlsxUrl() call.
//
// Counts the exact same "genuine Actual Knockback" population as the
// Actual Knockbacks figure above (see services/reports.js's
// computeKnockbackReasonsReport/genuineKnockbackJobs) — a knock-back keeps
// its original reason here even once its quote is later approved, since
// that's a separate Converted Later credit, never another knock-back.
export default function KnockbackReasonsTracker({ layout, setDrilldown, filters, setFilters, from, to }) {
  const settings = useSettings();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // The one place `from`/`to` join the rest of this box's own filters — every
  // request this component makes (the data fetch below, and the drill-down)
  // goes through this single merged object, so neither can ever drift from
  // the main report's own currently applied date range.
  const effectiveFilters = { ...filters, from, to };

  useEffect(() => {
    setLoading(true);
    api.reports.knockbackReasons(effectiveFilters).then((d) => {
      setData(d);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, from, to]);

  function patch(p) {
    setFilters((f) => ({ ...f, ...p }));
  }

  // Always carries the same from/to the box is currently showing — matching
  // the main report's own applied date range — plus this box's own
  // Technician/Trade filters.
  function openReasonDrilldown(reasonName) {
    setDrilldown({
      from,
      to,
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
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
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
            <button className="btn" type="button" onClick={() => setFilters(defaultKnockbackReasonsFilters())}>
              Clear filters
            </button>
            {!loading && data && (
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginLeft: 'auto', paddingBottom: 8 }}>
                {data.total} knock-back{data.total === 1 ? '' : 's'} — matches the report's date range above ({from || 'earliest'} to {to || 'latest'});
                click a reason to view its records.
              </div>
            )}
          </div>

          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : !data || data.total === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '20px 0', textAlign: 'center' }}>
              No knock-backs match these filters yet.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, alignItems: 'start' }}>
              <BarCardBody
                data={chartData}
                color="var(--chart-orange)"
                height={cfg.chartHeight}
                labelWidth={200}
                onBarClick={(name) => openReasonDrilldown(name)}
              />
              <div className="table-scroll" style={cfg.tableMaxHeight ? { maxHeight: cfg.tableMaxHeight, overflowY: 'auto' } : undefined}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Count</th>
                      <th>%</th>
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
            </div>
          )}
        </div>
      )}
    </AdjustableSection>
  );
}
