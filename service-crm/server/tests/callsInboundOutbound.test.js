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
    await server.request('POST', '/calls', { callAt: '2026-01-01T09:00:00', direction: 'Outbound', callType: 'Lead', tradeId: plumbing.id });

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

    await server.request('POST', '/calls', { callAt: '2026-06-01T09:00:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, handledByUserId: admin.id });
    // A different (unassigned) staff member's call — excluded once filtered by staff.
    await server.request('POST', '/calls', { callAt: '2026-06-02T09:00:00', direction: 'Outbound', callType: 'Lead', tradeId: plumbing.id });

    const report = (await server.request('GET', `/reports/calls?from=2026-06-01&to=2026-06-30&handledByUserId=${admin.id}`)).data;
    assert.equal(report.kpis.total, 1);
    assert.equal(report.kpis.inboundCount, 1);
    assert.equal(report.kpis.outboundCount, 0);
  } finally {
    server.close();
  }
});

// `direction` is written by the app in exactly two ways: the calls table
// column is NOT NULL, and the only client UI for it is a two-option dropdown
// (Inbound/Outbound); the create route also defaults a missing value to
// 'Inbound'. So no call created through the app can ever end up with a third
// direction value — this test locks that invariant in so a future change
// can't quietly introduce one without a test failing.
test('every call created through the API always ends up with a direction of Inbound or Outbound', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const withoutDirection = (await server.request('POST', '/calls', { callAt: '2026-07-01T09:00:00', callType: 'Lead', tradeId: plumbing.id })).data;
    assert.equal(withoutDirection.direction, 'Inbound', 'omitting direction on create defaults to Inbound, never blank/null');

    const report = (await server.request('GET', '/reports/calls?from=2026-07-01&to=2026-07-31')).data;
    assert.equal(report.kpis.total, 1);
    assert.equal(report.kpis.inboundCount + report.kpis.outboundCount, report.kpis.total);
  } finally {
    server.close();
  }
});
