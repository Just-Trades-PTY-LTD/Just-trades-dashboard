import { useSettings } from '../../lib/SettingsContext.jsx';
import { useTheme } from '../../lib/theme.js';
import { SubTabs } from '../../components/Fields.jsx';
import Lists from './Lists.jsx';
import Suburbs from './Suburbs.jsx';
import Users from './Users.jsx';
import DataPanel from './DataPanel.jsx';
import Activity from './Activity.jsx';

const THEME_CHOICES = [
  ['system', 'System default'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

// A per-browser display preference, not CRM data, but this page (like the
// rest of Settings) only ever renders for an admin — see App.jsx's isAdmin
// gate on the Settings tab itself.
function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Appearance</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 10 }}>
        "System default" follows your device's own light/dark setting.
      </div>
      <div className="subtabs" style={{ marginBottom: 0 }}>
        {THEME_CHOICES.map(([id, label]) => (
          <button key={id} className={`subtab ${theme === id ? 'active' : ''}`} onClick={() => setTheme(id)} type="button">
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage({ sub, setSub, isAdmin }) {
  const { refresh } = useSettings();

  if (!isAdmin) {
    return <div className="panel empty-state">Settings are managed by an administrator. Ask an admin if a list needs a new option.</div>;
  }

  return (
    <div>
      <AppearanceSection />
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['lists', 'Lists'],
          ['suburbs', 'Suburbs'],
          ['users', 'Staff accounts'],
          ['data', 'Data'],
          ['activity', 'Activity history'],
        ]}
      />
      {sub === 'lists' && <Lists />}
      {sub === 'suburbs' && <Suburbs refreshCount={refresh} />}
      {sub === 'users' && <Users />}
      {sub === 'data' && <DataPanel />}
      {sub === 'activity' && <Activity />}
    </div>
  );
}
