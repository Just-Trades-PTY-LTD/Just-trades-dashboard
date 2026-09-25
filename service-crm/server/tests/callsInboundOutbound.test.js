import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('Calls report splits Total Calls into Inbound/Outbound, respecting filters, and they always sum to the total', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const staffDirectory = (await server.request('GET', '/users/directory')).data;
    const admin = staffDirectory[0];

    await server.request('POST', '/calls', { callAt: '2026-05-01T09:00:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id, booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: '2026-05-02T09:00:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id, booked: 'No' });
    await server.request('POST', '/calls', { callAt: '2026-05-03T09:00:00', direction: 'Outbound', callType: 'Call back', tradeId: plumbing.id, handledByUserId: admin.id });
    // Outside the filtered range — must not affect the totals below.
    await server.request('POST', '/calls', { callAt: '2026-01-01T09:00:00', direction: 'Outbound', callType: 'Lead', tradeId: plumbing.id, booked: 'Yes' });

    const report = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;

    assert.equal(report.kpis.total, 3);
    assert.equal(report.kpis.inboundCount, 2);
    assert.equal(report.kpis.outboundCount, 1);
    assert.equal(report.kpis.inboundCount + report.kpis.outboundCount, report.kpis.total, 'inbound + outbound must equal total for the same period/filters');

    const staffRow = report.staffPerf.find((s) => s.name === admin.name);
    assert.equal(staffRow.total, 3);
    assert.equal(staffRow.inbound, 2);
    assert.equal(staffRow.outbound, 1);
    assert.equal(staffRow.inbound + staffRow.outbound, staffRow.total, 'per-staff inbound + outbound must equal per-staff total');
  } finally {
    server.close();
  }
});

test('Calls report inbound/outbound breakdown respects the staff filter the same way the total does', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const staffDirectory = (await server.request('GET', '/users/directory')).data;
    const admin = staffDirectory[0];

    await server.request('POST', '/calls', { callAt: '2026-06-01T09:00:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id, booked: 'Yes' });
    // A different (unassigned) staff member's call — excluded once filtered by staff.
    await server.request('POST', '/calls', { callAt: '2026-06-02T09:00:00', direction: 'Outbound', callType: 'Lead', tradeId: plumbing.id, booked: 'Yes' });

    const report = (await server.request('GET', `/reports/calls?from=2026-06-01&to=2026-06-30&handledByUserId=${admin.id}`)).data;
    assert.equal(report.kpis.total, 1);
    assert.equal(report.kpis.inboundCount, 1);
    assert.equal(report.kpis.outboundCount, 0);
  } finally {
    server.close();
  }
});

// Contact Method (the `direction` column) now starts blank in the UI and is
// required before a call can be saved — omitting it must be rejected, not
// silently defaulted, so a caller always knows exactly what was recorded.
test('creating a call without a Contact Method is rejected rather than silently defaulted', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const res = await server.request('POST', '/calls', { callAt: '2026-07-01T09:00:00', callType: 'Lead', tradeId: plumbing.id });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Please select a Contact Method before saving.');
  } finally {
    server.close();
  }
});

test('creating a call without a Call Type is rejected rather than silently defaulted', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const res = await server.request('POST', '/calls', { callAt: '2026-07-01T09:00:00', direction: 'Inbound', tradeId: plumbing.id });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Please select a Call Type before saving.');
  } finally {
    server.close();
  }
});

test('the new Contact Methods (Text Message, Email, Other / N/A) are each counted correctly in the report totals and breakdowns', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const staffDirectory = (await server.request('GET', '/users/directory')).data;
    const admin = staffDirectory[0];

    await server.request('POST', '/calls', { callAt: '2026-08-01T09:00:00', direction: 'Text Message', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id, booked: 'Yes' });
    await server.request('POST', '/calls', { callAt: '2026-08-02T09:00:00', direction: 'Email', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id, booked: 'No' });
    await server.request('POST', '/calls', { callAt: '2026-08-03T09:00:00', direction: 'Other / N/A', callType: 'Not lead', tradeId: plumbing.id, handledByUserId: admin.id });

    const report = (await server.request('GET', '/reports/calls?from=2026-08-01&to=2026-08-31')).data;
    assert.equal(report.kpis.total, 3);
    assert.equal(report.kpis.textMessageCount, 1);
    assert.equal(report.kpis.emailCount, 1);
    assert.equal(report.kpis.otherContactCount, 1);
    assert.equal(report.kpis.inboundCount, 0);
    assert.equal(report.kpis.outboundCount, 0);
    assert.equal(
      report.kpis.inboundCount + report.kpis.outboundCount + report.kpis.textMessageCount + report.kpis.emailCount + report.kpis.otherContactCount,
      report.kpis.total
    );

    const staffRow = report.staffPerf.find((s) => s.name === admin.name);
    assert.equal(staffRow.textMessage, 1);
    assert.equal(staffRow.email, 1);
    assert.equal(staffRow.otherContact, 1);
  } finally {
    server.close();
  }
});
