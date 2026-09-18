import { useState } from 'react';
import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';

export default function ReportsPage() {
  const [sub, setSub] = useState('calls');
  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['calls', 'Calls'],
          ['tech', 'Technician & sales'],
        ]}
      />
      {sub === 'calls' ? <CallsReport /> : <TechReport />}
    </div>
  );
}
