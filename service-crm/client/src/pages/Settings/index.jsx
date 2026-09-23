import { useSessionState } from '../../lib/useSessionState.js';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { SubTabs } from '../../components/Fields.jsx';
import Lists from './Lists.jsx';
import Suburbs from './Suburbs.jsx';
import Users from './Users.jsx';
import DataPanel from './DataPanel.jsx';
import Activity from './Activity.jsx';

export default function SettingsPage({ isAdmin }) {
  const { refresh } = useSettings();
  const [sub, setSub] = useSessionState('crm.settings.sub', 'lists');

  if (!isAdmin) {
    return <div className="panel empty-state">Settings are managed by an administrator. Ask an admin if a list needs a new option.</div>;
  }

  return (
    <div>
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
