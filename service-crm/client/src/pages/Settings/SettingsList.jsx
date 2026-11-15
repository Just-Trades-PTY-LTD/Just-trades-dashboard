import { useEffect, useState } from 'react';
import CollapsibleSection from '../../components/CollapsibleSection.jsx';

// Settings list rows (Admin only). Rename keeps the same item, so every
// record shows the new name. Hide takes it out of new entries while saved
// records and reports keep it. Remove is only for an item no record uses.
const usedText = (n) => (n ? `Used by ${n} record${n === 1 ? '' : 's'}` : 'Not used yet');

function EditableRow({ item, used, onRename, onHide, onRemove, onRequiresComment, locked, extra, setMessage }) {
  const [value, setValue] = useState(item.name);
  useEffect(() => setValue(item.name), [item.name]);
  async function save() {
    const v = value.trim();
    if (!v || v === item.name) return setValue(item.name);
    try {
      await onRename(item.id, v);
      setMessage({ text: `Renamed "${item.name}" to "${v}" — every record using it now shows the new name.` });
    } catch (err) {
      setValue(item.name);
      setMessage({ text: err.message, error: true });
    }
  }
  const canRemove = !used && !locked;
  return (
    <div className="list-row" data-testid="settings-item" style={{ flexWrap: 'wrap', rowGap: 4 }}>
      <input
        aria-label={`Name of ${item.name}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        style={{ flex: 1, minWidth: 160, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
      />
      {extra && extra(item)}
      <span style={{ fontSize: 11.5, color: 'var(--ink-muted)', minWidth: 104 }}>{usedText(used)}</span>
      {onRequiresComment && (
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }} title="Staff must add a comment when they choose this reason">
          <input type="checkbox" checked={!!item.requiresComment} onChange={(e) => onRequiresComment(item.id, e.target.checked)} />
          Requires comments
        </label>
      )}
      <button
        className="btn btn-sm"
        type="button"
        disabled={locked}
        title={locked ? 'Used for callbacks and repeat customers — choose a different Lead Source for that first' : 'Not offered for new entries; saved records and reports keep it'}
        onClick={() => onHide(item.id, true)}
      >
        Hide
      </button>
      <button
        className="btn btn-sm btn-danger"
        type="button"
        disabled={!canRemove}
        title={locked ? 'Used for callbacks and repeat customers' : used ? `${usedText(used)} — hide it instead` : 'Remove permanently (not used by any record)'}
        onClick={() => onRemove(item.id)}
      >
        Remove
      </button>
      {locked && <div style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--ink-muted)' }}>Used for callbacks and repeat customers — can be renamed, but not hidden or removed.</div>}
    </div>
  );
}

/** The rows of one list: visible items, then a collapsed "Hidden items" list.
 * Every action reports its outcome (or the server's reason) in the section. */
export function ItemRows({ items, usage = {}, onAdd, addLabel = 'Add item', onRename, onHide, onRemove, onRequiresComment, lockedId, extra, hiddenNote }) {
  const [message, setMessage] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const visible = items.filter((i) => !i.hidden);
  const hidden = items.filter((i) => i.hidden);
  const act = (fn, ok) => async (...args) => {
    try {
      await fn(...args);
      if (ok) setMessage({ text: typeof ok === 'function' ? ok(...args) : ok });
    } catch (err) {
      setMessage({ text: err.message, error: true });
    }
  };
  const nameOf = (id) => items.find((i) => i.id === id)?.name || 'Item';
  const hide = act(onHide, (id, h) => (h ? `"${nameOf(id)}" is hidden — not offered for new entries. Saved records and reports keep it.${hiddenNote ? ` ${hiddenNote}` : ''}` : `"${nameOf(id)}" is available again.`));
  const remove = act(async (id) => {
    if (!window.confirm(`Remove "${nameOf(id)}" permanently? No record uses it.`)) throw new Error('Nothing was removed.');
    await onRemove(id);
  }, 'Removed.');
  return (
    <div>
      {message && (
        <div className={`notice panel ${message.error ? 'error' : ''}`} style={{ marginBottom: 8, fontSize: 12.5 }} role="status">
          {message.text}
        </div>
      )}
      {visible.map((item) => (
        <EditableRow
          key={item.id}
          item={item}
          used={usage[item.id] || 0}
          onRename={onRename}
          onHide={hide}
          onRemove={remove}
          onRequiresComment={onRequiresComment && act(onRequiresComment, (id, on) => (on ? `"${nameOf(id)}" now requires comments.` : `"${nameOf(id)}" no longer requires comments.`))}
          locked={lockedId && item.id === lockedId}
          extra={extra}
          setMessage={setMessage}
        />
      ))}
      {onAdd && (
        <button className="btn" style={{ marginTop: 6 }} onClick={act(onAdd)} type="button">
          {addLabel}
        </button>
      )}
      {hidden.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-sm" type="button" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)}>
            {showHidden ? 'Hide' : 'Show'} hidden items ({hidden.length})
          </button>
          {showHidden &&
            hidden.map((item) => (
              <div key={item.id} className="list-row" data-testid="settings-hidden-item" style={{ opacity: 0.8 }}>
                <span style={{ flex: 1 }}>
                  {item.name} <span className="badge">Hidden</span>
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>{usedText(usage[item.id] || 0)}</span>
                <button className="btn btn-sm" type="button" onClick={() => hide(item.id, false)}>
                  Show again
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsList({ title, children, ...rows }) {
  return (
    <CollapsibleSection title={title}>
      {children}
      <ItemRows {...rows} />
    </CollapsibleSection>
  );
}
