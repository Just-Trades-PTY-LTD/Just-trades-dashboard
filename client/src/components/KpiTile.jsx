export default function KpiTile({ label, value, sublabel }) {
  return (
    <div className="kpi-tile">
      <div className="kpi-tile__label">{label}</div>
      <div className="kpi-tile__value">{value}</div>
      {sublabel && <div className="kpi-tile__sublabel">{sublabel}</div>}
    </div>
  );
}
