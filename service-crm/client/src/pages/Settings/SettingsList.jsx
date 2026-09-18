import { useState } from 'react';

function EditableRow({ item, onChange, onRemove, extra }) {
  const [value, setValue] = useState(item.name);
  return (
    <div className="list-row">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value.trim() && value !== item.name && onChange(item.id, value.trim())}
        style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
      />
      {extra && extra(item)}
      <button className="btn btn-sm btn-danger" onClick={() => onRemove(item.id)} type="button">
        Remove
      </button>
    </div>
  );
}

export default function SettingsList({ title, items, onAdd, onChange, onRemove, extra }) {
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {items.map((item) => (
        <EditableRow key={item.id} item={item} onChange={onChange} onRemove={onRemove} extra={extra} />
      ))}
      <button className="btn" style={{ marginTop: 6 }} onClick={onAdd} type="button">
        Add item
      </button>
    </div>
  );
}
