import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';
import ReviewsReport from './ReviewsReport.jsx';

export default function ReportsPage({
  sub,
  setSub,
  callsDrilldown,
  setCallsDrilldown,
  techDrilldown,
  setTechDrilldown,
  reviewsDrilldown,
  setReviewsDrilldown,
  jumpToJN,
  jumpToJobId,
}) {
  return (
    <div>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['calls', 'Calls & Contacts'],
          ['tech', 'Technician & sales'],
          ['reviews', 'Reviews'],
        ]}
      />
      {sub === 'calls' && <CallsReport jumpToJN={jumpToJN} drilldown={callsDrilldown} setDrilldown={setCallsDrilldown} />}
      {sub === 'tech' && <TechReport jumpToJN={jumpToJN} jumpToJobId={jumpToJobId} drilldown={techDrilldown} setDrilldown={setTechDrilldown} />}
      {sub === 'reviews' && <ReviewsReport drilldown={reviewsDrilldown} setDrilldown={setReviewsDrilldown} />}
    </div>
  );
}
