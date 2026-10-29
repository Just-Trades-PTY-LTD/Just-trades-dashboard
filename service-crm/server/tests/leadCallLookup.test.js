import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';
import { leadCallStatus } from '../../client/src/lib/leadCallStatus.js';

// GET /api/lookup/call's `leadCall`: the booked Lead call the reports credit
// a Job Number's Lead Source to, used only to warn on the New Job form when
// a job would report as "Unassigned". Must follow the reports' own rule
// exactly (earliest active Lead call booked "Yes") — checked here against
// the Technician & Sales Report's Lead Source filter on the same data — and
// must never change anything.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const tech = (await server.request('POST', '/settings/technicians', { name: 'LC Tech' })).data;
  return { plumbing, jobTypeId: plumbing.jobTypes[0].id, sourceA: bundle.lists.lead_source[0], sourceB: bundle.lists.lead_source[1], tech };
}

async function logCall(server, { jobNumber, callAt, callType = 'Lead', booked = 'Yes', leadSourceId = null }) {
  const res = await server.request('POST', '/calls', {
    callAt,
    direction: 'Inbound',
    callType,
    booked: callType === 'Lead' ? booked : '',
    leadSourceId,
    jobNumber,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

async function newJob(server, { tech, plumbing, jobTypeId, jobNumber }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate: '2026-05-01',
    technicianId: tech.id,
    jobNumber,
    tradeId: plumbing.id,
    jobTypeId,
    lead: 'Not Qualified',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
}

const lookupCall = async (server, jn) => (await server.request('GET', `/lookup/call?jn=${encodeURIComponent(jn)}`)).data;

test('the earliest booked Lead call is reported, matching how the reports attribute Lead Source', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, sourceB, tech } = await setup(server);
    await logCall(server, { jobNumber: 'JN-LC1', callAt: '2026-04-02T09:00', leadSourceId: sourceB.id });
    await logCall(server, { jobNumber: 'jn-lc1 ', callAt: '2026-04-01T09:00', leadSourceId: sourceA.id });
    await newJob(server, { tech, plumbing, jobTypeId, jobNumber: 'JN-LC1' });

    const res = await lookupCall(server, 'JN-LC1');
    assert.deepEqual(res.leadCall, { leadSource: sourceA.name, callAt: '2026-04-01T09:00' });

    // Same answer as the report itself.
    const bySource = (await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&leadSourceId=${sourceA.id}`)).data;
    assert.equal(bySource.company.jobsAttended, 1);
  } finally {
    server.close();
  }
});

test('calls the reports ignore for Lead Source leave leadCall empty, and the job reports as Unassigned', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, jobTypeId, sourceA, tech } = await setup(server);
    // A Lead call not booked, and a non-Lead call — neither counts.
    await logCall(server, { jobNumber: 'JN-LC2', callAt: '2026-04-01T09:00', booked: 'No', leadSourceId: sourceA.id });
    await logCall(server, { jobNumber: 'JN-LC3', callAt: '2026-04-01T09:00', callType: 'Not lead' });
    for (const jn of ['JN-LC2', 'JN-LC3', 'JN-LC4']) await newJob(server, { tech, plumbing, jobTypeId, jobNumber: jn });

    const notBooked = await lookupCall(server, 'JN-LC2');
    assert.equal(notBooked.found, true);
    assert.equal(notBooked.callType, 'Lead');
    assert.equal(notBooked.booked, 'No');
    assert.equal(notBooked.leadCall, null);

    const otherType = await lookupCall(server, 'JN-LC3');
    assert.equal(otherType.callType, 'Not lead');
    assert.equal(otherType.leadCall, null);

    const noCall = await lookupCall(server, 'JN-LC4');
    assert.deepEqual(noCall, { found: false, leadCall: null });

    const unassigned = (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31&leadSourceId=unassigned')).data;
    assert.equal(unassigned.company.jobsAttended, 3, 'all three jobs the lookup warns about are exactly the Unassigned ones');
  } finally {
    server.close();
  }
});

test('a booked Lead call with no Lead Source chosen is found, with a blank source', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    await logCall(server, { jobNumber: 'JN-LC5', callAt: '2026-04-01T09:00' });
    const res = await lookupCall(server, 'JN-LC5');
    assert.deepEqual(res.leadCall, { leadSource: '', callAt: '2026-04-01T09:00' });
  } finally {
    server.close();
  }
});

test('the lookup never changes any record', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    await logCall(server, { jobNumber: 'JN-LC6', callAt: '2026-04-01T09:00', leadSourceId: sourceA.id });
    const tables = ['calls', 'jobs', 'sales', 'audit_log'];
    const counts = () => tables.map((t) => dbAll(`SELECT COUNT(*) AS n FROM ${t}`)[0].n);
    const before = counts();
    const callsBefore = dbAll('SELECT * FROM calls');
    await lookupCall(server, 'JN-LC6');
    await lookupCall(server, 'JN-NOPE');
    assert.deepEqual(counts(), before);
    assert.deepEqual(dbAll('SELECT * FROM calls'), callsBefore);
  } finally {
    server.close();
  }
});

test('New Job form message for each case', () => {
  assert.equal(leadCallStatus('', { found: false, leadCall: null }), null);
  assert.equal(leadCallStatus('2572', null), null, 'nothing while the lookup is still loading');

  assert.deepEqual(leadCallStatus('2572', { found: true, leadCall: { leadSource: 'Google search', callAt: '2026-10-03T09:15' } }), {
    tone: 'found',
    text: 'Lead call found — Lead Source: Google search (call on 3 Oct 2026).',
  });

  const blankSource = leadCallStatus('2572', { found: true, leadCall: { leadSource: '', callAt: '2026-10-03T09:15' } });
  assert.equal(blankSource.tone, 'missing');
  assert.match(blankSource.text, /no Lead Source selected/);

  const notBooked = leadCallStatus('2572', { found: true, callType: 'Lead', booked: 'No', leadCall: null });
  assert.equal(notBooked.tone, 'missing');
  assert.match(notBooked.text, /is a Lead call not marked as booked\. .*"Unassigned"/);

  const otherType = leadCallStatus('2572', { found: true, callType: 'Call back', booked: '', leadCall: null });
  assert.match(otherType.text, /is a "Call back" call\. Lead Source reports only use booked Lead calls/);

  const none = leadCallStatus(' 2572 ', { found: false, leadCall: null });
  assert.deepEqual(none, {
    tone: 'missing',
    text: "No booked Lead call found for JN 2572. This job's Lead Source won't appear in reports until one is logged in Calls & Contacts.",
  });
});
