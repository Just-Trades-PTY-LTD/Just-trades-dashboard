import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('Inbound Calls by Time of Day groups only Inbound calls into hourly buckets, and the drill-down matches exactly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const from = '2026-02-01';
    const to = '2026-02-28';

    // 3 inbound at 8am, 1 inbound at 8am on a different day (same bucket),
    // 2 inbound at 2pm (14), 1 outbound at 8am (must not count), 1 inbound
    // outside the date range (must not count).
    const inboundAt = (time) => server.request('POST', '/calls', { callAt: `2026-02-05T${time}`, direction: 'Inbound', callType: 'Not lead' });
    await inboundAt('08:05');
    await inboundAt('08:20');
    await inboundAt('08:45');
    await server.request('POST', '/calls', { callAt: '2026-02-10T08:10', direction: 'Inbound', callType: 'Not lead' });
    await server.request('POST', '/calls', { callAt: '2026-02-05T14:00', direction: 'Inbound', callType: 'Not lead' });
    await server.request('POST', '/calls', { callAt: '2026-02-05T14:30', direction: 'Inbound', callType: 'Not lead' });
    await server.request('POST', '/calls', { callAt: '2026-02-05T08:15', direction: 'Outbound', callType: 'Not lead' });
    await server.request('POST', '/calls', { callAt: '2026-01-05T08:15', direction: 'Inbound', callType: 'Not lead' });

    const report = (await server.request('GET', `/reports/calls?from=${from}&to=${to}`)).data;
    const hour8 = report.inboundByHour.find((b) => b.hour === 8);
    const hour14 = report.inboundByHour.find((b) => b.hour === 14);
    assert.ok(hour8, 'hour 8 bucket should exist');
    assert.equal(hour8.value, 4);
    assert.equal(hour8.name, '8:00am – 8:59am');
    assert.ok(hour14, 'hour 14 bucket should exist');
    assert.equal(hour14.value, 2);
    assert.equal(hour14.name, '2:00pm – 2:59pm');
    // No bucket at all for an hour with zero inbound calls — not a fixed
    // 0-23 grid.
    assert.equal(report.inboundByHour.find((b) => b.hour === 9), undefined);
    // Buckets are sorted by hour, not by count.
    assert.deepEqual(report.inboundByHour.map((b) => b.hour), [...report.inboundByHour.map((b) => b.hour)].sort((a, b) => a - b));

    const drillHour8 = (await server.request('GET', `/reports/calls/drilldown?from=${from}&to=${to}&metric=inboundByHour&category=8`)).data;
    assert.equal(drillHour8.count, hour8.value);
    assert.ok(drillHour8.rows.every((r) => r.direction === 'Inbound' && r.callAt.slice(11, 13) === '08'));
    assert.equal(drillHour8.label, 'Inbound Calls by Time of Day — 8:00am – 8:59am');

    const drillHour14 = (await server.request('GET', `/reports/calls/drilldown?from=${from}&to=${to}&metric=inboundByHour&category=14`)).data;
    assert.equal(drillHour14.count, hour14.value);
  } finally {
    server.close();
  }
});
