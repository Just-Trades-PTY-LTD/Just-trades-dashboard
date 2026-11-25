import { SubTabs } from '../../components/Fields.jsx';
import CallsReport from './CallsReport.jsx';
import TechReport from './TechReport.jsx';
import ReviewsReport from './ReviewsReport.jsx';
import MissingEntriesTest from './MissingEntriesTest.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';

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
  // Missing entries check (AroFlo, read-only test): Admin accounts only.
  const isAdmin = useAuth().user?.role === 'admin';
  return (
    <div data-unsaved-ignore>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          ['calls', 'Calls & Contacts'],
          ['tech', 'Technician & sales'],
          ['reviews', 'Reviews'],
          ...(isAdmin ? [['missing', 'Missing entries (AroFlo test)']] : []),
        ]}
      />
      {sub === 'calls' && <CallsReport jumpToJN={jumpToJN} drilldown={callsDrilldown} setDrilldown={setCallsDrilldown} />}
      {sub === 'tech' && <TechReport jumpToJN={jumpToJN} jumpToJobId={jumpToJobId} drilldown={techDrilldown} setDrilldown={setTechDrilldown} />}
      {sub === 'reviews' && <ReviewsReport drilldown={reviewsDrilldown} setDrilldown={setReviewsDrilldown} />}
      {sub === 'missing' && isAdmin && <MissingEntriesTest />}
    </div>
  );
}
