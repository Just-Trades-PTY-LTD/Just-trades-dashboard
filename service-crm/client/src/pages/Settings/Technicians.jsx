import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import CollapsibleSection from '../../components/CollapsibleSection.jsx';

function TechnicianRow({ tech, onChange, onToggleActive, onRemove }) {
  const [name, setName] = useState(tech.name);
  const [deleteError, setDeleteError] = useState('');

  async function remove() {
    setDeleteError('');
    if (!window.confirm(`Remove ${tech.name}? This can't be undone.`)) return;
    try {
      await onRemove(tech.id);
    } catch (err) {
      setDeleteError(err.message);
    }
  }

  return (
    <div style={{ marginBottom: deleteError ? 4 : 0 }}>
      <div className="list-row" style={{ justifyContent: 'space-between', opacity: tech.active ? 1 : 0.6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== tech.name && onChange(tech.id, name.trim())}
          style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
        />
        {tech.active ? (
          <span className="badge badge-success">Active</span>
        ) : (
          <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--ink-muted)' }}>
            Inactive
          </span>
        )}
        <button className="btn btn-sm" onClick={() => onToggleActive(tech)} type="button">
          {tech.active ? 'Deactivate' : 'Reactivate'}
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={remove}
          type="button"
          disabled={tech.canDelete === false}
          title={
            tech.canDelete === false
              ? 'This technician has linked records and cannot be permanently deleted. Please deactivate them instead.'
              : undefined
          }
        >
          Remove
        </button>
      </div>
      {deleteError && (
        <div style={{ fontSize: 12, color: 'var(--alert)', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          {deleteError}
          {tech.active && (
            <button className="btn btn-sm" type="button" onClick={() => onToggleActive(tech)}>
              Deactivate instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Technicians() {
  const settings = useSettings();
  const { refresh } = settings;
  const [newName, setNewName] = useState('');

  async function add() {
    const name = newName.trim() || 'New technician';
    await api.settings.addTechnician(name);
    setNewName('');
    refresh();
  }

  async function rename(id, name) {
    await api.settings.updateTechnician(id, { name });
    refresh();
  }

  async function toggleActive(tech) {
    await api.settings.updateTechnician(tech.id, { active: !tech.active });
    refresh();
  }

  async function remove(id) {
    await api.settings.removeTechnician(id);
    refresh();
  }

  return (
    <CollapsibleSection title="Technicians">
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
        Deactivating a technician who's left keeps every job, sale, cancellation, report and activity entry they're on exactly as it
        is — it only stops them appearing when assigning new work.
      </div>
      {settings.technicians.map((tech) => (
        <TechnicianRow key={tech.id} tech={tech} onChange={rename} onToggleActive={toggleActive} onRemove={remove} />
      ))}
      <div className="list-row" style={{ marginTop: 6 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New technician name"
          style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
        />
        <button className="btn" onClick={add} type="button">
          Add technician
        </button>
      </div>
    </CollapsibleSection>
  );
}
