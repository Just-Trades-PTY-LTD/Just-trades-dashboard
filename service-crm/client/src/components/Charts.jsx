import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export const PIE_COLORS = ['#1b75ba', '#b4642a', '#3d8a6e', '#8a4fbf', '#a63d46', '#c9a227', '#4f9da6', '#6b8e4e'];

export function ChartPanel({ title, children, span2, headerRight }) {
  return (
    <div className={`panel ${span2 ? 'span-2' : ''}`} style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
        {headerRight}
      </div>
      {children}
    </div>
  );
}

export function PieCard({ title, data, formatValue }) {
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {data.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
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
      )}
    </div>
  );
}

export function BarCard({ title, data, color = '#1b75ba' }) {
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {data.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-muted)', padding: '30px 0', textAlign: 'center' }}>No data in this range yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid stroke="var(--border)" horizontal={false} />
            <XAxis type="number" allowDecimals={false} stroke="var(--ink-muted)" fontSize={12} />
            <YAxis type="category" dataKey="name" width={150} stroke="var(--ink-muted)" fontSize={11} />
            <Tooltip />
            <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer };
