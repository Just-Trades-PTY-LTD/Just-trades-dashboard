import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function createStaff(server, email = 'staff@justtrades.au') {
  await server.login(); // admin
  await server.request('POST', '/users', { name: 'Staff One', email, password: 'staff-pass-123', role: 'staff' });
  await server.login(email, 'staff-pass-123');
}

test('staff can do the normal operational work: create/edit calls, view history, archive, run reports, export to Excel', async () => {
  const server = await startTestServer();
  try {
    await createStaff(server);

    const bundle = (await server.request('GET', '/settings/bundle')).data;
    assert.ok(bundle.trades.length, 'staff can read the settings bundle needed to populate dropdowns');
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const call = await server.request('POST', '/calls', { callAt: '2026-05-01T09:00:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, booked: 'Yes' });
    assert.equal(call.status, 201, 'staff can create a call');

    const edit = await server.request('PATCH', `/calls/${call.data.id}`, { notes: 'updated by staff' });
    assert.equal(edit.status, 200, 'staff can edit a call');

    const history = await server.request('GET', `/calls/${call.data.id}/history`);
    assert.equal(history.status, 200, 'staff can view a call\'s history');

    const archive = await server.request('PATCH', `/calls/${call.data.id}/archive`, { archived: true });
    assert.equal(archive.status, 200, 'staff can archive a call');

    const job = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-05-01',
      jobNumber: 'JN-STAFF-1',
      tradeId: plumbing.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    assert.equal(job.status, 201, 'staff can create a tech/job entry');

    const jobEdit = await server.request('PATCH', `/tech/new-job/${job.data.entry.id}`, { comments: 'staff edit' });
    assert.equal(jobEdit.status, 200, 'staff can edit a tech/job entry');

    const jobArchive = await server.request('PATCH', `/tech/entries/new_job_no_sale/${job.data.entry.id}/archive`, { archived: true });
    assert.equal(jobArchive.status, 200, 'staff can archive a tech/job entry');

    const callsReport = await server.request('GET', '/reports/calls');
    assert.equal(callsReport.status, 200, 'staff can run the calls report');
    const techReport = await server.request('GET', '/reports/tech');
    assert.equal(techReport.status, 200, 'staff can run the tech report');

    const callsXlsx = await server.rawGet('/reports/calls.xlsx');
    assert.equal(callsXlsx.status, 200, 'staff can export the calls report to Excel');
    const techXlsx = await server.rawGet('/reports/tech.xlsx');
    assert.equal(techXlsx.status, 200, 'staff can export the tech report to Excel');
    const callHistoryXlsx = await server.rawGet('/calls/export.xlsx');
    assert.equal(callHistoryXlsx.status, 200, 'staff can export Call History to Excel');
    const jobHistoryXlsx = await server.rawGet('/tech/entries/export.xlsx');
    assert.equal(jobHistoryXlsx.status, 200, 'staff can export Job History to Excel');

    const layoutSave = await server.request('PUT', '/reports/layouts/calls', { layout: { kpis: { size: 'lg' } } });
    assert.equal(layoutSave.status, 200, 'staff can save their own report layout');
  } finally {
    server.close();
  }
});

test('staff cannot access or change Settings (lists, trades, technicians, suburbs)', async () => {
  const server = await startTestServer();
  try {
    await createStaff(server);

    assert.equal((await server.request('POST', '/settings/trades', { name: 'New trade' })).status, 403);
    assert.equal((await server.request('PATCH', '/settings/trades/1', { name: 'x' })).status, 403);
    assert.equal((await server.request('DELETE', '/settings/trades/1')).status, 403);
    assert.equal((await server.request('POST', '/settings/technicians', { name: 'New tech' })).status, 403);
    assert.equal((await server.request('PATCH', '/settings/technicians/1', { name: 'x' })).status, 403);
    assert.equal((await server.request('DELETE', '/settings/technicians/1')).status, 403);
    assert.equal((await server.request('POST', '/settings/lists/lead_source', { name: 'x' })).status, 403);
    assert.equal((await server.request('PATCH', '/settings/list-items/1', { name: 'x' })).status, 403);
    assert.equal((await server.request('DELETE', '/settings/list-items/1')).status, 403);
    assert.equal((await server.request('POST', '/settings/suburbs', { name: 'Testville', postcode: '1234' })).status, 403);
    assert.equal((await server.request('POST', '/settings/suburbs/bulk-import', { text: 'a,1234' })).status, 403);
  } finally {
    server.close();
  }
});

test('staff cannot create, edit or deactivate staff accounts', async () => {
  const server = await startTestServer();
  try {
    await createStaff(server);
    assert.equal((await server.request('GET', '/users')).status, 403, 'staff cannot list full user accounts');
    assert.equal((await server.request('POST', '/users', { name: 'x', email: 'x@justtrades.au', password: 'password123' })).status, 403);
    assert.equal((await server.request('PATCH', '/users/1', { active: false })).status, 403);
  } finally {
    server.close();
  }
});

test('staff cannot access the admin activity/audit history', async () => {
  const server = await startTestServer();
  try {
    await createStaff(server);
    assert.equal((await server.request('GET', '/audit/activity')).status, 403);
  } finally {
    server.close();
  }
});

test('staff cannot use backup, restore or data-clearing controls', async () => {
  const server = await startTestServer();
  try {
    await createStaff(server);
    assert.equal((await server.rawGet('/export/backup.json')).status, 403);
    assert.equal((await server.request('POST', '/export/restore', { tables: {} })).status, 403);
    assert.equal((await server.rawGet('/export/auto-backups')).status, 403);
    assert.equal((await server.request('POST', '/export/clear-calls')).status, 403);
    assert.equal((await server.request('POST', '/export/clear-tech-data')).status, 403);
    assert.equal((await server.rawGet('/export/calls.csv')).status, 403);
    assert.equal((await server.rawGet('/export/tech-entries.csv')).status, 403);
  } finally {
    server.close();
  }
});

test('an admin retains full access to every settings, user-management, audit and backup control', async () => {
  const server = await startTestServer();
  try {
    await server.login(); // admin

    assert.equal((await server.request('POST', '/settings/trades', { name: 'Roofing' })).status, 201);
    assert.equal((await server.request('GET', '/users')).status, 200);
    assert.equal((await server.request('GET', '/audit/activity')).status, 200);
    assert.equal((await server.rawGet('/export/backup.json')).status, 200);
    assert.equal((await server.rawGet('/export/auto-backups')).status, 200);
  } finally {
    server.close();
  }
});
