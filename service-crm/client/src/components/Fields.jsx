export function TextField({ label, value, onChange, placeholder, mono, style, maxWidth }) {
  return (
    <div className="field" style={{ maxWidth, ...style }}>
      {label && <label>{label}</label>}
      <input
        className={mono ? 'mono' : undefined}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function NumberField({ label, value, onChange, style, maxWidth }) {
  return (
    <div className="field" style={{ maxWidth, ...style }}>
      {label && <label>{label}</label>}
      <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function DateField({ label, value, onChange, style, maxWidth = 170, invalid }) {
  return (
    <div className={`field${invalid ? ' invalid' : ''}`} style={{ maxWidth, ...style }}>
      {label && <label>{label}</label>}
      <input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function DateTimeField({ label, value, onChange, style }) {
  return (
    <div className="field" style={style}>
      {label && <label>{label}</label>}
      <input type="datetime-local" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function TextAreaField({ label, value, onChange, rows = 3, placeholder, invalid }) {
  return (
    <div className={`field${invalid ? ' invalid' : ''}`}>
      {label && <label>{label}</label>}
      <textarea rows={rows} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// options: array of {id,name} OR array of plain strings.
export function SelectField({ label, value, onChange, options, placeholder = '—', disabled, style, maxWidth, invalid }) {
  const isObjectOptions = options.length > 0 && typeof options[0] === 'object';
  return (
    <div className={`field${invalid ? ' invalid' : ''}`} style={{ maxWidth, ...style }}>
      {label && <label>{label}</label>}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{disabled ? placeholder : placeholder}</option>
        {options.map((o) =>
          isObjectOptions ? (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ) : (
            <option key={o} value={o}>
              {o}
            </option>
          )
        )}
      </select>
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options }) {
  const isObjectOptions = options.length > 0 && typeof options[0] === 'object';
  return (
    <div className="field" style={{ maxWidth: 180 }}>
      <label>{label}</label>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) =>
          isObjectOptions ? (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ) : (
            <option key={o} value={o}>
              {o}
            </option>
          )
        )}
      </select>
    </div>
  );
}

export function YesNoField({ label, value, onChange }) {
  return <SelectField label={label} value={value} onChange={onChange} options={['Yes', 'No', 'N/A']} />;
}

export function Checkbox({ label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 'auto' }} />
      {label}
    </label>
  );
}

export function SubTabs({ value, onChange, tabs }) {
  return (
    <div className="subtabs">
      {tabs.map(([id, label]) => (
        <button key={id} className={`subtab ${value === id ? 'active' : ''}`} onClick={() => onChange(id)} type="button">
          {label}
        </button>
      ))}
    </div>
  );
}
