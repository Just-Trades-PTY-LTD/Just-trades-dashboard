import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import SettingsList, { ItemRows } from './SettingsList.jsx';
import Technicians from './Technicians.jsx';
import CollapsibleSection from '../../components/CollapsibleSection.jsx';

const LIST_CATEGORIES = [
  ['lead_source', 'Lead sources'],
  ['not_booked_reason', 'Not-booked reasons'],
  ['new_job_cancellation_reason', 'New Job Cancellation reasons (booked, cancelled before attending)'],
  ['knockback_reason', 'Knock-back reasons'],
  ['callback_reason', 'Call back reasons'],
  ['pending_cancellation_reason', 'Pending Cancellation reasons (sold, cancelled before completing)'],
];

function JobTypesEditor({ trades, refresh, usage }) {
  const [tradeId, setTradeId] = useState(trades[0]?.id || '');
  const trade = trades.find((t) => t.id === Number(tradeId));
  // A job type hidden only because its Trade is hidden still shows here as
  // visible; the note explains the Trade hides it for new entries.
  const items = trade ? trade.jobTypes.map((jt) => ({ ...jt, hidden: jt.ownHidden })) : [];

  return (
    <CollapsibleSection title="Job types by trade">
      <div className="field" style={{ marginBottom: 10 }}>
        <label>For trade</label>
        <select value={tradeId} onChange={(e) => setTradeId(e.target.value)}>
          {trades.map((t) => (
            <option key={t.id} value={t.id}>
              {t.hidden ? `${t.name} (hidden)` : t.name}
            </option>
          ))}
        </select>
      </div>
      {trade?.hidden && (
        <div className="notice panel" style={{ marginBottom: 8, fontSize: 12.5 }}>
          {trade.name} is hidden, so none of its Job types are offered for new entries. Saved records keep them.
        </div>
      )}
      {trade && (
        <ItemRows
          key={trade.id}
          items={items}
          usage={usage.jobTypes}
          addLabel="Add job type"
          onAdd={() => api.settings.addJobType(trade.id).then(refresh)}
          onRename={(id, name) => api.settings.updateJobType(id, name).then(refresh)}
          onHide={(id, hidden) => api.settings.setJobTypeHidden(id, hidden).then(refresh)}
          onRemove={(id) => api.settings.removeJobType(id).then(refresh)}
        />
      )}
    </CollapsibleSection>
  );
}

// Which Lead Source callbacks and repeat customers are credited to — by id,
// so it can be renamed. Changing it is recorded in Settings Activity.
function RepeatCustomerChoice({ leadSources, currentId, source, refresh }) {
  const [message, setMessage] = useState(null);
  async function choose(id) {
    try {
      await api.settings.setRepeatCustomerLeadSource(Number(id));
      await refresh();
      setMessage({ text: 'Saved — callbacks and repeat customers are credited to this Lead Source.' });
    } catch (err) {
      setMessage({ text: err.message, error: true });
    }
  }
  return (
    <div className="panel" style={{ padding: 12, marginBottom: 10 }} data-testid="repeat-customer-choice">
      <div className="field" style={{ marginBottom: 4 }}>
        <label>Lead Source used for callbacks and repeat customers</label>
        <select value={currentId || ''} onChange={(e) => e.target.value && choose(e.target.value)}>
          {!currentId && <option value="">— choose —</option>}
          {leadSources
            .filter((l) => !l.hidden || l.id === currentId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-muted)' }}>
        {source === 'setting'
          ? 'Callbacks and callback sales report under this Lead Source, and returning customers are suggested it. You can rename it freely.'
          : source === 'name'
            ? 'Currently found by its name "Repeat customer". Choose it here to keep it working if it is renamed.'
            : 'No Lead Source is set — choose one so callbacks report correctly.'}
      </div>
      {message && (
        <div className={`notice panel ${message.error ? 'error' : ''}`} style={{ marginTop: 6, fontSize: 12.5 }}>
          {message.text}
        </div>
      )}
    </div>
  );
}

export default function Lists() {
  const settings = useSettings();
  const { refresh } = settings;
  const [usage, setUsage] = useState({ listItems: {}, trades: {}, jobTypes: {} });
  const loadUsage = useCallback(() => api.settings.usage().then(setUsage).catch(() => {}), []);
  useEffect(() => {
    loadUsage();
  }, [loadUsage]);
  const reload = () => Promise.all([refresh(), loadUsage()]);

  return (
    <div className="grid-charts">
      <SettingsList
        title="Trades"
        items={settings.trades}
        usage={usage.trades}
        addLabel="Add trade"
        hiddenNote="Its Job types are hidden from new entries too."
        onAdd={() => api.settings.addTrade().then(reload)}
        onRename={(id, name) => api.settings.updateTrade(id, name).then(reload)}
        onHide={(id, hidden) => api.settings.setTradeHidden(id, hidden).then(reload)}
        onRemove={(id) => api.settings.removeTrade(id).then(reload)}
      />
      <JobTypesEditor trades={settings.trades} refresh={reload} usage={usage} />
      <Technicians />
      {LIST_CATEGORIES.map(([category, title]) => (
        <SettingsList
          key={category}
          title={title}
          items={settings.lists[category]}
          usage={usage.listItems}
          lockedId={category === 'lead_source' ? settings.repeatCustomerLeadSourceId : null}
          onAdd={() => api.settings.addListItem(category).then(reload)}
          onRename={(id, name) => api.settings.updateListItem(id, name).then(reload)}
          onHide={(id, hidden) => api.settings.setListItemHidden(id, hidden).then(reload)}
          onRemove={(id) => api.settings.removeListItem(id).then(reload)}
          onRequiresComment={category === 'lead_source' ? null : (id, on) => api.settings.setRequiresComment(id, on).then(reload)}
        >
          {category === 'lead_source' && (
            <RepeatCustomerChoice
              leadSources={settings.lists.lead_source}
              currentId={settings.repeatCustomerLeadSourceId}
              source={settings.repeatCustomerSource}
              refresh={reload}
            />
          )}
        </SettingsList>
      ))}
    </div>
  );
}
