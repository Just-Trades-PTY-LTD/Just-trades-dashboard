import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/routes/arofloTest.js';

// Stage 1 AroFlo test page's summarize() — pure function, no network/DB
// involved, so this is tested directly against realistic mock AroFlo
// responses (shaped from real test lookups already run against the live
// API) rather than needing a live token. Covers:
//   - every raw field (task.resources, task.schedule, task.location) is
//     surfaced as-is, never collapsed into a single guessed value
//   - nothing is labelled as "the" attending/selling technician
//   - missing/absent fields never throw, they resolve to null/[]

test('surfaces task.schedule, its resources and start/end time, separately from task.resources', () => {
  const task = {
    id: 'K890006Y468',
    jobNumber: '2605',
    name: '65 Tyne Avenue, Kilburn',
    description: '<p>replace ceiling fan and install new power point</p>',
    status: 'PENDING',
    taskType: { name: 'Fans' },
    location: null,
    locationText: '65 Tyne Avenue Kilburn SA 5084 AUSTRALIA',
    enteredBy: 'Service Coordinator',
    reportedBy: null,
    requestedDateTime: '2026-10-22T13:25:13',
    invoiced: false,
    resources: [],
    schedule: {
      resources: [{ note: null, type: 'USER', name: 'Ryan S El Install' }],
      groupId: 'K890000000G',
      startTime: '2026-11-04T07:00:00',
      endTime: '2026-11-04T09:00:00',
    },
  };
  const summary = summarize(task, []);

  assert.deepEqual(summary.taskResources, [], 'task.resources shown as-is, even when empty');
  assert.deepEqual(summary.scheduleResources, [{ note: null, type: 'USER', name: 'Ryan S El Install' }]);
  assert.equal(summary.scheduleStartTime, '2026-11-04T07:00:00');
  assert.equal(summary.scheduleEndTime, '2026-11-04T09:00:00');
  assert.deepEqual(summary.schedule, task.schedule, 'the full schedule object is surfaced unmodified, nothing picked out of it is a different value');
  assert.equal(summary.location, null, 'the full location object is surfaced as-is (null here, matching task.location)');

  // Never guesses or labels a single "attending"/"selling" technician.
  assert.ok(!('attendingTechnician' in summary));
  assert.ok(!('sellingTechnician' in summary));
  assert.ok(!('assignedUsers' in summary), 'the old collapsed/guessed field is gone, not just renamed');
});

test('surfaces the full location object (id, suburb, postcode, etc.) whenever AroFlo returns one, not only the suburb string', () => {
  const task = {
    id: 'K8900001',
    jobNumber: '9001',
    taskType: {},
    location: { id: 'LOC-123', suburb: 'Joslin', postcode: '5070', state: 'SA' },
    resources: [{ resourceType: 'USER', status: 'ASSIGNED', resource: 'Some Name', id: 'USR-1' }],
    schedule: null,
  };
  const summary = summarize(task, []);

  assert.equal(summary.suburb, 'Joslin');
  assert.deepEqual(summary.location, { id: 'LOC-123', suburb: 'Joslin', postcode: '5070', state: 'SA' });
  assert.deepEqual(summary.taskResources, [{ resourceType: 'USER', status: 'ASSIGNED', resource: 'Some Name', id: 'USR-1' }]);
  assert.deepEqual(summary.scheduleResources, [], 'no schedule on this task, so scheduleResources is empty, never guessed from taskResources');
  assert.equal(summary.scheduleStartTime, null);
  assert.equal(summary.scheduleEndTime, null);
  assert.equal(summary.schedule, null);
});

test('never throws when location, schedule and resources are all absent', () => {
  const task = { id: 'K8900002', jobNumber: '9002', taskType: null };
  const summary = summarize(task, []);

  assert.equal(summary.suburb, null);
  assert.equal(summary.location, null);
  assert.deepEqual(summary.taskResources, []);
  assert.equal(summary.schedule, null);
  assert.deepEqual(summary.scheduleResources, []);
  assert.equal(summary.scheduleStartTime, null);
  assert.equal(summary.scheduleEndTime, null);
});

test('still summarizes invoices exactly as before (unchanged by this investigation update)', () => {
  const task = { id: 'K8900003', jobNumber: '9003', taskType: {} };
  const invoices = [
    { id: 1, invoiceNumber: 'INV-1', invoicedDateTime: '2026-10-01', totalAmountEx: 500, status: 'IN_PROGRESS', type: 'PART_INVOICE' },
    { id: 2, invoiceNumber: 'INV-2', invoicedDateTime: '2026-10-05', totalAmountEx: 200, status: 'PAID', type: 'FULL_INVOICE' },
  ];
  const summary = summarize(task, invoices);

  assert.equal(summary.invoiceCount, 2);
  assert.deepEqual(summary.invoices, [
    { id: 1, invoiceNumber: 'INV-1', invoicedDateTime: '2026-10-01', totalAmountEx: 500, status: 'IN_PROGRESS', type: 'PART_INVOICE' },
    { id: 2, invoiceNumber: 'INV-2', invoicedDateTime: '2026-10-05', totalAmountEx: 200, status: 'PAID', type: 'FULL_INVOICE' },
  ]);
});
