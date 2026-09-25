import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('activity feed is admin-only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/users', { name: 'Staff Sam', email: 'sam@justtrades.au', password: 'password123', role: 'staff' });

    const asAdmin = await server.request('GET', '/audit/activity');
    assert.equal(asAdmin.status, 200);

    await server.login('sam@justtrades.au', 'password123');
    const asStaff = await server.request('GET', '/audit/activity');
    assert.equal(asStaff.status, 403);
  } finally {
    server.close();
  }
});

test('creating a call records a "created" activity entry with the record identifiable', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const call = await server.request('POST', '/calls', {
      callAt: '2026-09-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      jobNumber: 'JN-ACT-1',
      notes: 'First contact',
      booked: 'Yes',
    });
    assert.equal(call.status, 201);

    const activity = (await server.request('GET', '/audit/activity')).data;
    const entry = activity.rows.find((r) => r.entityType === 'call' && r.entityId === call.data.id);
    assert.ok(entry, 'a call creation should appear in the activity feed');
    assert.equal(entry.action, 'created');
    assert.equal(entry.by, 'Admin');
    assert.equal(entry.entityTypeLabel, 'Call');
    assert.match(entry.record, /JN-ACT-1/);
    assert.equal(entry.changes.job_number.to, 'JN-ACT-1');
  } finally {
    server.close();
  }
});

test('editing a call records a separate "edited" activity entry showing what changed', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const call = await server.request('POST', '/calls', { callAt: '2026-09-02T09:00', direction: 'Inbound', callType: 'Not lead' });

    await server.request('PATCH', `/calls/${call.data.id}`, { suburb: 'Adelaide' });

    const activity = (await server.request('GET', '/audit/activity')).data;
    const entriesForCall = activity.rows.filter((r) => r.entityType === 'call' && r.entityId === call.data.id);
    assert.equal(entriesForCall.length, 2, 'one created entry and one edited entry');
    const created = entriesForCall.find((r) => r.action === 'created');
    const edited = entriesForCall.find((r) => r.action === 'edited');
    assert.ok(created);
    assert.ok(edited);
    assert.deepEqual(edited.changes.suburb, { from: '', to: 'Adelaide' });
  } finally {
    server.close();
  }
});

test('a New Job — Sale Made entry logs the job and the sale as two separate created records', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Cody' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-09-05',
      technicianId: tech.id,
      jobNumber: 'JN-ACT-2',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      invoiceNumber: 'INV-ACT-2',
      invoiceDate: '2026-09-05',
      saleValueExGst: 500,
    });

    const activity = (await server.request('GET', '/audit/activity')).data;
    const jobEntry = activity.rows.find((r) => r.entityType === 'job' && r.action === 'created' && r.record.includes('JN-ACT-2'));
    const saleEntry = activity.rows.find((r) => r.entityType === 'sale' && r.action === 'created' && r.record.includes('JN-ACT-2'));
    assert.ok(jobEntry, 'the job itself should be logged as created');
    assert.ok(saleEntry, 'the linked sale should also be logged as created, separately');
    assert.match(saleEntry.record, /INV-ACT-2/);
  } finally {
    server.close();
  }
});

test('activity feed can be filtered by entity type', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/calls', { callAt: '2026-09-06T09:00', direction: 'Inbound', callType: 'Not lead' });
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Tylor' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-06',
      technicianId: tech.id,
      jobNumber: 'JN-ACT-3',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const callsOnly = (await server.request('GET', '/audit/activity?entityType=call')).data;
    assert.ok(callsOnly.rows.every((r) => r.entityType === 'call'));
    assert.ok(callsOnly.rows.length > 0);

    const jobsOnly = (await server.request('GET', '/audit/activity?entityType=job')).data;
    assert.ok(jobsOnly.rows.every((r) => r.entityType === 'job'));
    assert.ok(jobsOnly.rows.length > 0);
  } finally {
    server.close();
  }
});

test('deleting a record leaves its activity trail intact with a fallback label', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const call = await server.request('POST', '/calls', { callAt: '2026-09-07T09:00', direction: 'Inbound', callType: 'Not lead', jobNumber: 'JN-ACT-4' });
    await server.request('DELETE', `/calls/${call.data.id}`);

    const activity = (await server.request('GET', '/audit/activity')).data;
    const entry = activity.rows.find((r) => r.entityType === 'call' && r.entityId === call.data.id);
    assert.ok(entry, 'the activity entry for a deleted record must still exist — deleting the record never deletes its history');
    assert.match(entry.record, /deleted/);
  } finally {
    server.close();
  }
});
