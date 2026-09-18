import { useState } from 'react';
import { useSettings } from '../../lib/SettingsContext.jsx';
import { SubTabs } from '../../components/Fields.jsx';
import Lists from './Lists.jsx';
import Suburbs from './Suburbs.jsx';
import Users from './Users.jsx';
import DataPanel from './DataPanel.jsx';

export default function SettingsPage({ isAdmin }) {
  const { refresh } = useSettings();
  const [sub, setSub] = useState('lists');

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
        ]}
      />
      {sub === 'lists' && <Lists />}
      {sub === 'suburbs' && <Suburbs refreshCount={refresh} />}
      {sub === 'users' && <Users />}
      {sub === 'data' && <DataPanel />}
    </div>
  );
}
