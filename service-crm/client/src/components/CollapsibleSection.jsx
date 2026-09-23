import { useState } from 'react';

export default function CollapsibleSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="panel" style={{ padding: 18 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          marginBottom: open ? 10 : 0,
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          fontSize: 13.5,
          fontWeight: 600,
          color: 'inherit',
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-muted)' }}>{open ? '▲ Collapse' : '▼ Expand'}</span>
      </button>
      {open && children}
    </div>
  );
}
