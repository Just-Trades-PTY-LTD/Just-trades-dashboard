const STATUS_LABELS = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  on_hold: 'On hold',
  completed: 'Completed',
  overdue: 'Overdue',
};

function isToday(isoDate) {
  const date = new Date(isoDate);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function startOfWeek() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * Turns raw AroFlo staff/jobs/timesheets into the shape the dashboard renders.
 */
export function buildDashboard({ staff, jobs, timesheets }) {
  const weekStart = startOfWeek();

  const jobsByTech = new Map();
  for (const job of jobs) {
    const list = jobsByTech.get(job.assignedstaffid) || [];
    list.push(job);
    jobsByTech.set(job.assignedstaffid, list);
  }

  const hoursTodayByTech = new Map();
  const hoursWeekByTech = new Map();
  for (const entry of timesheets) {
    if (isToday(entry.date)) {
      hoursTodayByTech.set(entry.staffid, (hoursTodayByTech.get(entry.staffid) || 0) + entry.hours);
    }
    if (new Date(entry.date) >= weekStart) {
      hoursWeekByTech.set(entry.staffid, (hoursWeekByTech.get(entry.staffid) || 0) + entry.hours);
    }
  }

  const technicians = staff.map((tech) => {
    const techJobs = jobsByTech.get(tech.staffid) || [];
    const jobsToday = techJobs.filter((job) => isToday(job.scheduledstart));
    const currentJob = techJobs.find((job) => job.status === 'in_progress');
    const nextJob = jobsToday
      .filter((job) => job.status === 'scheduled')
      .sort((a, b) => new Date(a.scheduledstart) - new Date(b.scheduledstart))[0];

    return {
      staffId: tech.staffid,
      name: `${tech.firstname} ${tech.lastname}`,
      role: tech.role,
      status: currentJob ? 'on_job' : jobsToday.some((j) => j.status === 'scheduled') ? 'available' : 'off',
      currentJob: currentJob
        ? { clientName: currentJob.clientname, address: currentJob.siteaddress, description: currentJob.description }
        : null,
      nextJob: nextJob
        ? { clientName: nextJob.clientname, scheduledStart: nextJob.scheduledstart, description: nextJob.description }
        : null,
      jobsCompletedToday: jobsToday.filter((job) => job.status === 'completed').length,
      jobsRemainingToday: jobsToday.filter((job) => job.status === 'scheduled' || job.status === 'in_progress').length,
      overdueJobs: techJobs.filter((job) => job.status === 'overdue').length,
      hoursToday: Math.round((hoursTodayByTech.get(tech.staffid) || 0) * 10) / 10,
      hoursThisWeek: Math.round((hoursWeekByTech.get(tech.staffid) || 0) * 10) / 10,
    };
  });

  const jobsToday = jobs.filter((job) => isToday(job.scheduledstart));
  const statusCounts = {};
  for (const status of Object.keys(STATUS_LABELS)) statusCounts[status] = 0;
  for (const job of jobsToday) {
    statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;
  }

  const summary = {
    techniciansActive: technicians.filter((t) => t.status !== 'off').length,
    techniciansTotal: technicians.length,
    jobsInProgress: statusCounts.in_progress || 0,
    jobsCompletedToday: statusCounts.completed || 0,
    jobsOverdue: jobs.filter((job) => job.status === 'overdue').length,
    hoursLoggedToday: Math.round(technicians.reduce((sum, t) => sum + t.hoursToday, 0) * 10) / 10,
  };

  const jobStatusBreakdown = Object.entries(STATUS_LABELS).map(([status, label]) => ({
    status,
    label,
    count: statusCounts[status] || 0,
  }));

  return { summary, technicians, jobStatusBreakdown, generatedAt: new Date().toISOString() };
}
