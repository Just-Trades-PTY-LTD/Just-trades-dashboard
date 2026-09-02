const VARIANTS = {
  on_job: { label: 'On job', className: 'status-dot--good' },
  available: { label: 'Available', className: 'status-dot--info' },
  off: { label: 'Off today', className: 'status-dot--muted' },
};

export default function StatusBadge({ status }) {
  const variant = VARIANTS[status] || VARIANTS.off;
  return (
    <span className="status-badge">
      <span className={`status-dot ${variant.className}`} aria-hidden="true" />
      {variant.label}
    </span>
  );
}
