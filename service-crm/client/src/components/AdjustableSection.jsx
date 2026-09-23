import { SECTION_SIZES } from '../lib/reportLayout.js';

// Visual configuration for each size level. `full` spans the section across
// both grid-charts columns (same mechanism as the existing .span-2 class);
// chartHeight/tableMaxHeight are handed to the section's own content via the
// render-prop `children(cfg)` so each chart/table can size itself.
export const SIZE_CONFIG = {
  sm: { full: false, chartHeight: 150, tableMaxHeight: 220, kpiMinCardWidth: 120 },
  md: { full: false, chartHeight: 220, tableMaxHeight: 380, kpiMinCardWidth: 160 },
  lg: { full: true, chartHeight: 300, tableMaxHeight: null, kpiMinCardWidth: 200 },
};

export default function AdjustableSection({ id, title, defaultSize = 'md', layout, headerRight, children }) {
  const { size, collapsed } = layout.get(id, defaultSize);
  const cfg = SIZE_CONFIG[size];
  const idx = SECTION_SIZES.indexOf(size);

  return (
    <div className={`panel ${cfg.full ? 'span-2' : ''}`} style={{ padding: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: collapsed ? 0 : 10,
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!collapsed && headerRight}
          <button
            className="btn btn-sm"
            type="button"
            title="Make section smaller"
            disabled={collapsed || idx === 0}
            onClick={() => layout.setSize(id, SECTION_SIZES[idx - 1])}
          >
            −
          </button>
          <button
            className="btn btn-sm"
            type="button"
            title="Expand section"
            disabled={collapsed || idx === SECTION_SIZES.length - 1}
            onClick={() => layout.setSize(id, SECTION_SIZES[idx + 1])}
          >
            +
          </button>
          <button
            className="btn btn-sm"
            type="button"
            title={collapsed ? 'Restore section' : 'Minimise section'}
            onClick={() => layout.setCollapsed(id, !collapsed)}
          >
            {collapsed ? '▼ Restore' : '▲ Minimise'}
          </button>
        </div>
      </div>
      {!collapsed && children(cfg)}
    </div>
  );
}
