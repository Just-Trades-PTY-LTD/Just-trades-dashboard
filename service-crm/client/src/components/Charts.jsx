import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export const PIE_COLORS = ['#1b75ba', '#b4642a', '#3d8a6e', '#8a4fbf', '#a63d46', '#c9a227', '#4f9da6', '#6b8e4e'];

// Bare chart content, sized by the caller (Reports pages wrap these in
// AdjustableSection, which supplies the panel/title/controls and hands each
// section's chosen height down through the `height` prop).
export function PieCardBody({ data, formatValue, height = 240 }) {
  if (data.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>;
  }
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
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => (formatValue ? formatValue(v) : v)} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function BarCardBody({ data, color = '#1b75ba', height = 220 }) {
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
