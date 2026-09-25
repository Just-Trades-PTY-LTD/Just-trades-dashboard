import { useSessionState } from '../../lib/useSessionState.js';
import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';

export default function ReportsPage({ jumpToJN }) {
  const [sub, setSub] = useSessionState('crm.reports.sub', 'calls');
  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['calls', 'Calls & Contacts'],
          ['tech', 'Technician & sales'],
        ]}
      />
      {sub === 'calls' ? <CallsReport jumpToJN={jumpToJN} /> : <TechReport jumpToJN={jumpToJN} />}
    </div>
  );
}
