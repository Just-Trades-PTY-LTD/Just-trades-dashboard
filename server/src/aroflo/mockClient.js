const TECHNICIANS = [
  { staffid: 'T-101', firstname: 'Liam', lastname: 'Nguyen', role: 'Electrician' },
  { staffid: 'T-102', firstname: 'Chloe', lastname: 'Barrett', role: 'Plumber' },
  { staffid: 'T-103', firstname: 'Marcus', lastname: 'Silva', role: 'Electrician' },
  { staffid: 'T-104', firstname: 'Aisha', lastname: 'Khan', role: 'HVAC Tech' },
  { staffid: 'T-105', firstname: 'Ben', lastname: 'Whitfield', role: 'Plumber' },
  { staffid: 'T-106', firstname: 'Priya', lastname: 'Ramesh', role: 'Electrician' },
];

const JOB_STATUSES = ['scheduled', 'in_progress', 'on_hold', 'completed', 'overdue'];

function seededRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function buildJobs() {
  const rand = seededRandom(42);
  const today = startOfToday();
  const clients = [
    'Fenwick Strata', 'Coastal Retail Group', 'Harborview Apartments', 'Bendal Manufacturing',
    'Southgate Medical Centre', 'Pryor & Co Offices', 'Milbank School', 'Redwood Logistics',
  ];
  const suburbs = ['Fremantle', 'Joondalup', 'Cannington', 'Midland', 'Rockingham', 'Subiaco'];
  const jobs = [];
  let jobCounter = 1000;

  for (const tech of TECHNICIANS) {
    const jobsToday = 3 + Math.floor(rand() * 3); // 3-5 jobs per technician today
    for (let i = 0; i < jobsToday; i++) {
      const hour = 7 + i * 2 + Math.floor(rand() * 2);
      const scheduledStart = new Date(today);
      scheduledStart.setHours(hour, rand() > 0.5 ? 30 : 0, 0, 0);
      const durationMinutes = 60 + Math.floor(rand() * 90);
      const scheduledEnd = new Date(scheduledStart.getTime() + durationMinutes * 60000);

      let status;
      const now = new Date();
      if (scheduledEnd < now) {
        status = rand() < 0.85 ? 'completed' : 'overdue';
      } else if (scheduledStart <= now && now <= scheduledEnd) {
        status = 'in_progress';
      } else {
        status = rand() < 0.1 ? 'on_hold' : 'scheduled';
      }

      jobs.push({
        jobid: `JOB-${jobCounter++}`,
        jobno: `2026-${jobCounter}`,
        status,
        assignedstaffid: tech.staffid,
        clientname: clients[Math.floor(rand() * clients.length)],
        siteaddress: `${10 + Math.floor(rand() * 200)} ${suburbs[Math.floor(rand() * suburbs.length)]} Rd`,
        description: ['Switchboard fault', 'Hot water system repair', 'Split system install',
          'Preventative maintenance', 'Leak investigation', 'Compliance inspection'][Math.floor(rand() * 6)],
        scheduledstart: scheduledStart.toISOString(),
        scheduledend: scheduledEnd.toISOString(),
      });
    }
  }
  return jobs;
}

function buildTimesheets(jobs) {
  const rand = seededRandom(7);
  return jobs
    .filter((job) => job.status === 'completed' || job.status === 'in_progress')
    .map((job) => {
      const start = new Date(job.scheduledstart);
      const now = new Date();
      const end = job.status === 'completed' ? new Date(job.scheduledend) : now;
      const hours = Math.max(0, (end - start) / 3600000) * (0.85 + rand() * 0.3);
      return {
        timesheetid: `TS-${job.jobid}`,
        staffid: job.assignedstaffid,
        jobid: job.jobid,
        date: start.toISOString().slice(0, 10),
        hours: Math.round(hours * 100) / 100,
      };
    });
}

export class AroFloMockClient {
  constructor() {
    this._jobs = buildJobs();
    this._timesheets = buildTimesheets(this._jobs);
  }

  async listStaff() {
    return TECHNICIANS;
  }

  async listJobs() {
    return this._jobs;
  }

  async listTimesheets() {
    return this._timesheets;
  }
}

export { JOB_STATUSES };
