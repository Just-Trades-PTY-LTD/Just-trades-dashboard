import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { useReportLayout } from '../../lib/reportLayout.js';
import { useReportFilters } from '../../lib/useReportFilters.js';
import { currentAdelaideWeek, DATE_RANGE_PRESETS, matchDateRangePreset } from '../../lib/dates.js';
import { DateField, FilterSelect, DateRangePresetSelect } from '../../components/Fields.jsx';
import { PieCardBody } from '../../components/Charts.jsx';
import AdjustableSection from '../../components/AdjustableSection.jsx';
import DrilldownModal from '../../components/DrilldownModal.jsx';
import { withInactiveLabel } from '../../lib/activeOptions.js';

const RATING_OPTIONS = [
  { id: '5', name: '5 stars' },
  { id: '4', name: '4 stars' },
  { id: '3', name: '3 stars' },
  { id: '2', name: '2 stars' },
  { id: '1', name: '1 star' },
];
const CLASSIFICATION_OPTIONS = [
  { id: 'Positive', name: 'Positive (4–5)' },
  { id: 'Neutral', name: 'Neutral (3)' },
  { id: 'Negative', name: 'Negative (1–2)' },
];

const CLASSIFICATION_COLORS = { Positive: 'var(--success)', Neutral: 'var(--warn)', Negative: 'var(--alert)' };

function defaultFilters() {
  return { ...currentAdelaideWeek(), technicianId: '', rating: '', ratingClass: '', reviewLinkSent: '' };
}

export default function ReviewsReport({ drilldown, setDrilldown }) {
  const settings = useSettings();
  const { draft, applied, patch, error, refresh, reset } = useReportFilters(defaultFilters, 'crm.reports.reviews.filters');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const layout = useReportLayout('reviews');

  useEffect(() => {
    setLoading(true);
    api.reports.reviews(applied).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, [applied]);

  // Every clickable figure/chart section opens the same modal against the
  // /reports/reviews/drilldown endpoint, carrying this report's own
  // currently *applied* filters plus whichever selector that figure needs —
  // see services/reports.js's drilldownReviews().
  function openDrilldown(metric, extra) {
    setDrilldown({ ...applied, metric, kind: 'reviews', ...extra });
  }

  if (!data || !layout.loaded) return <div className="empty-state">Loading…</div>;
  const { kpis, byTechnician } = data;

  const kpiRows = [
    ['Total Reviews', kpis.total, 'total'],
    ['Positive Reviews', kpis.positive, 'positive'],
    ['Neutral Reviews', kpis.neutral, 'neutral'],
    ['Negative Reviews', kpis.negative, 'negative'],
    ['Average Star Rating', kpis.avgRating, 'avgRating'],
    ['Review Link Sent — Yes', kpis.linkSentYes, 'linkSentYes'],
    ['Review Link Sent — No', kpis.linkSentNo, 'linkSentNo'],
  ];

  const classificationPie = [
    { name: 'Positive', value: kpis.positive },
    { name: 'Neutral', value: kpis.neutral },
    { name: 'Negative', value: kpis.negative },
  ].filter((d) => d.value > 0);

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
        <FilterSelect label="Star rating" value={draft.rating} onChange={(v) => patch({ rating: v, ratingClass: '' })} options={RATING_OPTIONS} />
        <FilterSelect
          label="Classification"
          value={draft.ratingClass}
          onChange={(v) => patch({ ratingClass: v, rating: '' })}
          options={CLASSIFICATION_OPTIONS}
        />
        <FilterSelect label="Review link sent" value={draft.reviewLinkSent} onChange={(v) => patch({ reviewLinkSent: v })} options={['Yes', 'No']} />
        <a className="btn btn-primary" href={api.reports.reviewsXlsxUrl(applied)}>
          Export to Excel
        </a>
        <button className="btn" type="button" onClick={reset}>
          Reset Filters
        </button>
        <button className="btn btn-primary" type="button" onClick={refresh} disabled={loading} style={{ marginLeft: 'auto' }}>
          {loading ? 'Refreshing…' : 'Refresh Report'}
        </button>
      </div>

      {error && (
        <div className="notice panel error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

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

      <div className="grid-charts">
        <AdjustableSection id="classificationPie" title="Positive / Neutral / Negative" defaultSize="md" layout={layout}>
          {(cfg) => (
            <PieCardBody
              data={classificationPie}
              height={cfg.chartHeight}
              colorFor={(name) => CLASSIFICATION_COLORS[name]}
              onSliceClick={(name) => openDrilldown(name.toLowerCase())}
            />
          )}
        </AdjustableSection>

        <AdjustableSection id="byTechnician" title="Reviews by technician" defaultSize="lg" layout={layout}>
          {(cfg) => (
            <div className="table-scroll" style={cfg.tableMaxHeight ? { maxHeight: cfg.tableMaxHeight, overflowY: 'auto' } : undefined}>
              {byTechnician.length === 0 ? (
                <div className="empty-state">No reviews in this range yet.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Technician</th>
                      <th>Reviews</th>
                      <th>Positive Reviews</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byTechnician.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="clickable-stat" onClick={() => openDrilldown('reviewsByTechnician', { scopeTechnician: r.name })} title={`View ${r.name}'s reviews`}>
                          {r.total}
                        </td>
                        <td
                          className="clickable-stat"
                          onClick={() => openDrilldown('positiveReviewsByTechnician', { scopeTechnician: r.name })}
                          title={`View ${r.name}'s positive reviews`}
                        >
                          {r.positive}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </AdjustableSection>
      </div>

      {drilldown && <DrilldownModal kind="reviews" params={drilldown} onClose={() => window.history.back()} />}
    </div>
  );
}
