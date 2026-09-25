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
// reasons, metric series). Fixed order; never reused for a trade.
export const PIE_COLORS = ['var(--chart-teal)', 'var(--chart-orange)', 'var(--chart-violet)', 'var(--chart-magenta)', 'var(--chart-green)'];

// Deterministic name -> slot so a category keeps its colour even when a
// filter changes which categories appear or their order — an index cycle
// would repaint the survivors.
function hashIndex(name, length) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % length;
}

export function tradeColor(name) {
  return TRADE_COLORS[name] || PIE_COLORS[hashIndex(name || '', PIE_COLORS.length)];
}

export function categoryColor(name) {
  return PIE_COLORS[hashIndex(name || '', PIE_COLORS.length)];
}

// Bare chart content, sized by the caller (Reports pages wrap these in
// AdjustableSection, which supplies the panel/title/controls and hands each
// section's chosen height down through the `height` prop).
export function PieCardBody({ data, formatValue, height = 240, colorFor }) {
  if (data.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
  const getColor = colorFor || ((name) => categoryColor(name));
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
          label={({ name, value }) => `${name}: ${formatValue ? formatValue(value) : value}`}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={getColor(entry.name)} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => (formatValue ? formatValue(v) : v)} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function BarCardBody({ data, color = 'var(--chart-teal)', height = 220 }) {
  if (data.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid stroke="var(--border)" horizontal={false} />
        <XAxis type="number" allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
        <YAxis type="category" dataKey="name" width={150} stroke="var(--ink-muted)" fontSize={11} />
        <Tooltip />
        <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer };
