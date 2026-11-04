import { createContext, useContext } from 'react';

// How a report page may be used. Admin/Staff get the default (full access:
// normal report API, record drill-downs, exports). A Technician account gets
// { technician: true, ownTechnicianName, openOwnRecords } from
// pages/Me/TechnicianApp.jsx: the report then reads the restricted
// statistics-only API, offers no export, and only the signed-in
// technician's own By technician figures open (their own) records.
export const ReportAccessContext = createContext({ technician: false });

export function useReportAccess() {
  return useContext(ReportAccessContext);
}

// The technician's own By technician figures that open their own records —
// the same cells that are clickable in the admin By technician row.
export const OWN_RECORD_FIELDS = new Set([
  'jobsAttended',
  'qualifiedJobs',
  'sales',
  'convertedLaterCredits',
  'actualKnockbacks',
  'totalSaleExGst',
  'avgSaleExGst',
  'callBacks',
  'pendingCancellations',
  'inspectionRate',
  'optionRate',
]);
