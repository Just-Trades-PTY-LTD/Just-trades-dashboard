import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export function SuburbPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState([]);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api.settings
        .searchSuburbs(value || '')
        .then(setOptions)
        .catch(() => setOptions([]));
    }, 150);
    return () => clearTimeout(debounceRef.current);
  }, [value]);

  return (
    <div className="field combobox">
      <label>Suburb (SA)</label>
      <input
        value={value ?? ''}
        placeholder="Search suburb or postcode…"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && options.length > 0 && (
        <div className="combobox-menu">
          {options.map((s) => (
            <div
              key={s.id}
              className="combobox-option"
              onMouseDown={() => {
                onChange(s.postcode ? `${s.name} (${s.postcode})` : s.name);
                setOpen(false);
              }}
            >
              <span>{s.name}</span>
              {s.postcode && <span className="mono" style={{ color: 'var(--ink-muted)' }}>{s.postcode}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
