import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// New Calls Report filters: Lead Source (incl. Unassigned), Job Number,
// Suburb, Contact Method, Call Type, Booked, Cancellation type/reason,
// Call-back reason, Call Follow-up Required, Created By, Last Edited By,
// Notes search. See services/reports.js's fetchCallsRaw(). Purely additive:
// every filter narrows the same single `calls` population, no cross-table
// propagation needed (unlike the Technician & Sales Report).

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const sourceA = bundle.lists.lead_source[0];
  const admin = (await server.request('GET', '/auth/me')).data.user;
  return { sourceA, admin };
}

test('Lead Source filter (incl. Unassigned) narrows the Calls Report to the exact matching calls', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: sourceA.id });
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'No' });

    const withSource = (await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&leadSourceId=${sourceA.id}`)).data;
    assert.equal(withSource.kpis.total, 1);

    const unassigned = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&leadSourceId=unassigned')).data;
    assert.equal(unassigned.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Job Number and Suburb filters match exactly, case/whitespace-insensitively', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      booked: 'Yes',
      jobNumber: 'JN-CF-1',
      suburb: 'Glenelg (5045)',
    });
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'No', suburb: 'Unley (5061)' });

    const byJn = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&jobNumber=jn-cf-1')).data;
    assert.equal(byJn.kpis.total, 1);

    const bySuburb = (await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&suburb=${encodeURIComponent('glenelg (5045)')}`)).data;
    assert.equal(bySuburb.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Contact Method, Call Type, Booked and Cancellation type/reason filters each narrow correctly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const cancelReasonId = bundle.lists.new_job_cancellation_reason[0].id;
    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Outbound', callType: 'Lead', booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'No' });
    await server.request('POST', '/calls', {
      callAt: '2026-05-01T11:00',
      direction: 'Inbound',
      callType: 'Cancellation',
      cancellationType: 'New Job Cancellation',
      cancellationReasonId: cancelReasonId,
      jobNumber: 'JN-CF-CANCEL',
    });

    const outbound = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&direction=Outbound')).data;
    assert.equal(outbound.kpis.total, 1);

    const cancellations = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&callType=Cancellation')).data;
    assert.equal(cancellations.kpis.total, 1);

    const booked = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&callType=Lead&booked=Yes')).data;
    assert.equal(booked.kpis.total, 1);

    const byCancelReason = (
      await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&cancellationType=New%20Job%20Cancellation&cancellationReasonId=${cancelReasonId}`)
    ).data;
    assert.equal(byCancelReason.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Call Follow-up Required filters on the call\'s own flag only', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', followUp: true });
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'No', followUp: false });

    const required = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&followUpRequired=Yes')).data;
    assert.equal(required.kpis.total, 1);

    const notRequired = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&followUpRequired=No')).data;
    assert.equal(notRequired.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Created By and Notes search filter correctly', async () => {
  const server = await startTestServer();
  try {
    const { admin } = await setup(server);
    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', notes: 'Customer asked about a quote for a hot water unit' });
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'No', notes: 'Unrelated enquiry' });

    const createdBy = (await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&createdByUserId=${admin.id}`)).data;
    assert.equal(createdBy.kpis.total, 2, 'both calls were created by the same logged-in admin in this test');

    const byNotes = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31&notes=hot%20water')).data;
    assert.equal(byNotes.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Last Edited By filters by whoever most recently saved the record, derived from the audit log', async () => {
  const server = await startTestServer();
  try {
    const { admin } = await setup(server);
    const created = await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes' });
    await server.request('PATCH', `/calls/${created.data.id}`, { notes: 'edited' });

    const data = (await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&lastEditedByUserId=${admin.id}`)).data;
    assert.equal(data.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Multiple Calls Report filters combine with AND semantics', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      booked: 'Yes',
      leadSourceId: sourceA.id,
      tradeId: plumbing.id,
    });
    // Same Lead Source, different trade — excluded by the combination.
    await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: sourceA.id });

    const data = (
      await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&leadSourceId=${sourceA.id}&tradeId=${plumbing.id}`)
    ).data;
    assert.equal(data.kpis.total, 1);
  } finally {
    server.close();
  }
});

test('Reading the Calls Report with the new filters never mutates any call record', async () => {
  const server = await startTestServer();
  try {
    const { sourceA } = await setup(server);
    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: sourceA.id, notes: 'test' });

    const before = dbAll('SELECT * FROM calls ORDER BY id');
    await server.request('GET', `/reports/calls?from=2026-05-01&to=2026-05-31&leadSourceId=${sourceA.id}&notes=test&followUpRequired=No`);
    await server.request('GET', '/reports/calls.xlsx?from=2026-05-01&to=2026-05-31');
    const after = dbAll('SELECT * FROM calls ORDER BY id');
    assert.deepEqual(after, before);
  } finally {
    server.close();
  }
});
