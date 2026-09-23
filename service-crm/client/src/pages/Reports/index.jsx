import { useSessionState } from '../../lib/useSessionState.js';
import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';

export default function ReportsPage() {
  const [sub, setSub] = useSessionState('crm.reports.sub', 'calls');
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
