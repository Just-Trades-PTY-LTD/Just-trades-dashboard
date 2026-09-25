import { useState } from 'react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// Trade identity colours — fixed, same trade = same colour everywhere it
// appears (summary cards, breakdowns, charts, legends). Hex values behind
// these vars live in styles.css and are validated with the dataviz skill's
// scripts/validate_palette.js.
const TRADE_COLORS = {
  Plumbing: 'var(--trade-plumbing)',
  Electrical: 'var(--trade-electrical)',
  'Heating & Cooling': 'var(--trade-heating-cooling)',
};

// Bright categorical set for everything else (referral sources, cancellation
// reasons, metric series). Fixed order — validated adjacent-safe (including
// the wrap from last back to first, since pie slices form a ring) so that
// categories rendered next to each other never share a colour family, e.g.
// orange and green never sit side by side (a classic red-green colour-blind
// confusion pair). Assigned by render position, not by name: a fixed name-hash
// could place two same-family colours next to each other by chance whenever
// the data happens to put those two categories adjacent.
export const PIE_COLORS = [
  'var(--trade-plumbing)',
  'var(--chart-orange)',
  'var(--chart-teal)',
  'var(--trade-electrical)',
  'var(--chart-magenta)',
  'var(--chart-green)',
  'var(--chart-violet)',
  'var(--trade-heating-cooling)',
];

export function tradeColor(name) {
  return TRADE_COLORS[name] || null;
}

const LABEL_RADIAN = Math.PI / 180;

// Recharts' default pie label paints the text in the slice's own fill colour,
// which makes the bright yellow slice's label barely readable on a light
// surface. Labels always render in the page's ink colour instead — text
// wears text tokens, never the series colour — so every label stays legible
// regardless of which bright colour its slice uses.
function renderPieLabel({ cx, cy, midAngle, outerRadius, name, value, formatValue }) {
  const radius = outerRadius + 18;
  const x = cx + radius * Math.cos(-midAngle * LABEL_RADIAN);
  const y = cy + radius * Math.sin(-midAngle * LABEL_RADIAN);
  return (
    <text x={x} y={y} fill="var(--ink)" fontSize={12} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central">
      {name}: {formatValue ? formatValue(value) : value}
    </text>
  );
}

// Bare chart content, sized by the caller (Reports pages wrap these in
// AdjustableSection, which supplies the panel/title/controls and hands each
// section's chosen height down through the `height` prop). Pass `onSliceClick`
// to make every slice a drill-down into the exact records it represents —
// the tooltip keeps working as normal; clicking is additive, not a
// replacement for hover.
export function PieCardBody({ data, formatValue, height = 240, colorFor, onSliceClick }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  if (data.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
  const getColor = (name, i) => (colorFor && colorFor(name)) || PIE_COLORS[i % PIE_COLORS.length];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={85}
          label={(props) => renderPieLabel({ ...props, formatValue })}
        >
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={getColor(entry.name, i)}
              stroke={onSliceClick && hoverIndex === i ? 'var(--ink)' : 'var(--surface)'}
              strokeWidth={onSliceClick && hoverIndex === i ? 2 : 1}
              style={onSliceClick ? { cursor: 'pointer' } : undefined}
              onClick={onSliceClick ? () => onSliceClick(entry.name, entry) : undefined}
              onMouseEnter={onSliceClick ? () => setHoverIndex(i) : undefined}
              onMouseLeave={onSliceClick ? () => setHoverIndex(null) : undefined}
            />
          ))}
        </Pie>
        <Tooltip formatter={(v) => (formatValue ? formatValue(v) : v)} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function BarCardBody({ data, color = 'var(--chart-teal)', height = 220, onBarClick }) {
  if (data.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid stroke="var(--border)" horizontal={false} />
        <XAxis type="number" allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
        <YAxis type="category" dataKey="name" width={150} stroke="var(--ink-muted)" fontSize={11} />
        <Tooltip cursor={{ fill: 'var(--surface-2)' }} />
        <Bar
          dataKey="value"
          fill={color}
          radius={[0, 3, 3, 0]}
          onClick={onBarClick ? (entry) => onBarClick(entry.name, entry) : undefined}
          style={onBarClick ? { cursor: 'pointer' } : undefined}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer };
