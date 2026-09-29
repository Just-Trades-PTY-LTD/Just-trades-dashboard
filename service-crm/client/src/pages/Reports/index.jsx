import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';

export default function ReportsPage({ sub, setSub, callsDrilldown, setCallsDrilldown, techDrilldown, setTechDrilldown, jumpToJN }) {
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
      {sub === 'calls' ? (
        <CallsReport jumpToJN={jumpToJN} drilldown={callsDrilldown} setDrilldown={setCallsDrilldown} />
      ) : (
        <TechReport jumpToJN={jumpToJN} drilldown={techDrilldown} setDrilldown={setTechDrilldown} />
      )}
    </div>
  );
}
