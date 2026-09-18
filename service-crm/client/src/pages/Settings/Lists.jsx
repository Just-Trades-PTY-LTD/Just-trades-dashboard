import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import SettingsList from './SettingsList.jsx';

const LIST_CATEGORIES = [
  ['lead_source', 'Lead sources'],
  ['not_booked_reason', 'Not-booked reasons'],
  ['new_job_cancellation_reason', 'New job cancellation reasons'],
  ['pending_job_cancellation_reason', 'Pending job cancellation reasons (booked, not yet attended)'],
  ['knockback_reason', 'Knock-back reasons'],
  ['callback_reason', 'Call back reasons'],
  ['pending_cancellation_reason', 'Pending cancellation reasons (sold job, refund pending)'],
];

function JobTypesEditor({ trades, refresh }) {
  const [tradeId, setTradeId] = useState(trades[0]?.id || '');
  const trade = trades.find((t) => t.id === Number(tradeId));

  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>Job types by trade</div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>For trade</label>
        <select value={tradeId} onChange={(e) => setTradeId(e.target.value)}>
          {trades.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {trade &&
        trade.jobTypes.map((jt) => (
          <div key={jt.id} className="list-row">
            <input
              defaultValue={jt.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== jt.name && api.settings.updateJobType(jt.id, e.target.value.trim()).then(refresh)}
              style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5 }}
            />
            <button className="btn btn-sm btn-danger" onClick={() => api.settings.removeJobType(jt.id).then(refresh)} type="button">
              Remove
            </button>
          </div>
        ))}
      <button className="btn" style={{ marginTop: 6 }} onClick={() => api.settings.addJobType(tradeId, 'New job type').then(refresh)} type="button" disabled={!tradeId}>
        Add job type
      </button>
    </div>
  );
}

export default function Lists() {
  const settings = useSettings();
  const { refresh } = settings;

  return (
    <div className="grid-charts">
      <SettingsList
        title="Trades"
        items={settings.trades}
        onAdd={() => api.settings.addTrade('New trade').then(refresh)}
        onChange={(id, name) => api.settings.updateTrade(id, name).then(refresh)}
        onRemove={(id) => window.confirm('Remove this trade? Its job types go with it.') && api.settings.removeTrade(id).then(refresh)}
      />
      <JobTypesEditor trades={settings.trades} refresh={refresh} />
      <SettingsList
        title="Technicians"
        items={settings.technicians}
        onAdd={() => api.settings.addTechnician('New technician').then(refresh)}
        onChange={(id, name) => api.settings.updateTechnician(id, { name }).then(refresh)}
        onRemove={(id) => window.confirm('Remove this technician?') && api.settings.removeTechnician(id).then(refresh)}
      />
      {LIST_CATEGORIES.map(([category, title]) => (
        <SettingsList
          key={category}
          title={title}
          items={settings.lists[category]}
          onAdd={() => api.settings.addListItem(category, 'New item').then(refresh)}
          onChange={(id, name) => api.settings.updateListItem(id, name).then(refresh)}
          onRemove={(id) => api.settings.removeListItem(id).then(refresh)}
        />
      ))}
    </div>
  );
}
