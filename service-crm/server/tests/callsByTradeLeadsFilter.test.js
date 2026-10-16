import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// "Calls by Trade" / "Leads by Trade" toggle, plus a whole-report Trade
// filter, on the Calls & Contacts report. Must satisfy, in full:
//   - Calls by Trade counts every call/contact record with a trade set
//     (unchanged from before)
//   - Leads by Trade counts only call_type === 'Lead' records, grouped the
//     same way
//   - both respect the report's existing date/staff filters
//   - a new Trade filter narrows every figure on the report (KPIs, both
//     trade breakdowns, everything), the same way Staff already does
//   - both trade breakdowns' drill-downs return exactly the matching
//     records, never more/fewer
//   - this is display/reporting only — no call record is altered

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const electrical = bundle.trades.find((t) => t.name === 'Electrical');
  const staffDirectory = (await server.request('GET', '/users/directory')).data;
  const admin = staffDirectory[0];
  return { plumbing, electrical, admin };
}

test('Calls by Trade counts every call with a trade; Leads by Trade counts only Lead-type calls, same grouping', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, electrical, admin } = await setup(server);

    // Plumbing: one Lead, one Not lead — both count in "Calls by Trade",
    // only the Lead counts in "Leads by Trade".
    await server.request('POST', '/calls', {
      callAt: '2026-05-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    await server.request('POST', '/calls', {
      callAt: '2026-05-02T09:00:00',
      direction: 'Inbound',
      callType: 'Not lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
    });
    // Electrical: one Lead.
    await server.request('POST', '/calls', {
      callAt: '2026-05-03T09:00:00',
      direction: 'Outbound',
      callType: 'Lead',
      tradeId: electrical.id,
      handledByUserId: admin.id,
      booked: 'No',
    });
    // A Call Back with a trade attached — never a lead, but still a plain
    // call/contact record, so it belongs in Calls by Trade.
    await server.request('POST', '/calls', {
      callAt: '2026-05-04T09:00:00',
      direction: 'Outbound',
      callType: 'Call back',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
    });

    const report = (await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31')).data;

    const callsPlumbing = report.byTrade.find((r) => r.name === 'Plumbing');
    const callsElectrical = report.byTrade.find((r) => r.name === 'Electrical');
    assert.equal(callsPlumbing.value, 3, 'Calls by Trade counts the Lead, the Not lead, and the Call back');
    assert.equal(callsElectrical.value, 1);

    const leadsPlumbing = report.leadsByTrade.find((r) => r.name === 'Plumbing');
    const leadsElectrical = report.leadsByTrade.find((r) => r.name === 'Electrical');
    assert.equal(leadsPlumbing.value, 1, 'Leads by Trade counts only the one Lead-type Plumbing call');
    assert.equal(leadsElectrical.value, 1);
  } finally {
    server.close();
  }
});

test('a Trade filter on the Calls report narrows every figure — KPIs and both trade breakdowns', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, electrical, admin } = await setup(server);

    await server.request('POST', '/calls', {
      callAt: '2026-06-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    await server.request('POST', '/calls', {
      callAt: '2026-06-02T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: electrical.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });

    const unfiltered = (await server.request('GET', '/reports/calls?from=2026-06-01&to=2026-06-30')).data;
    assert.equal(unfiltered.kpis.total, 2);

    const filtered = (await server.request('GET', `/reports/calls?from=2026-06-01&to=2026-06-30&tradeId=${plumbing.id}`)).data;
    assert.equal(filtered.kpis.total, 1, 'the Trade filter narrows the Total Contacts KPI itself, not just the chart');
    assert.equal(filtered.kpis.leadsCount, 1);
    assert.equal(filtered.byTrade.length, 1);
    assert.equal(filtered.byTrade[0].name, 'Plumbing');
    assert.equal(filtered.leadsByTrade.length, 1);
    assert.equal(filtered.leadsByTrade[0].name, 'Plumbing');
  } finally {
    server.close();
  }
});

test('the byTrade and leadsByTrade drill-downs return exactly the matching records, respecting date/staff/trade filters', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, admin } = await setup(server);

    const lead = await server.request('POST', '/calls', {
      callAt: '2026-07-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
      booked: 'Yes',
    });
    const notLead = await server.request('POST', '/calls', {
      callAt: '2026-07-02T09:00:00',
      direction: 'Inbound',
      callType: 'Not lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
    });
    assert.equal(lead.status, 201);
    assert.equal(notLead.status, 201);

    const byTradeDrill = (
      await server.request('GET', `/reports/calls/drilldown?from=2026-07-01&to=2026-07-31&metric=byTrade&category=Plumbing`)
    ).data;
    assert.equal(byTradeDrill.count, 2, 'Calls by Trade drill-down includes both the Lead and the Not lead');
    assert.ok(byTradeDrill.rows.some((r) => r.id === lead.data.id));
    assert.ok(byTradeDrill.rows.some((r) => r.id === notLead.data.id));

    const leadsByTradeDrill = (
      await server.request('GET', `/reports/calls/drilldown?from=2026-07-01&to=2026-07-31&metric=leadsByTrade&category=Plumbing`)
    ).data;
    assert.equal(leadsByTradeDrill.count, 1, 'Leads by Trade drill-down includes only the Lead');
    assert.equal(leadsByTradeDrill.rows[0].id, lead.data.id);
    assert.equal(leadsByTradeDrill.label, 'Leads by trade — Plumbing');
  } finally {
    server.close();
  }
});

test('reading the new leadsByTrade figure and the Trade filter never alters any call record', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, admin } = await setup(server);
    const created = await server.request('POST', '/calls', {
      callAt: '2026-08-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      handledByUserId: admin.id,
      booked: 'Yes',
      notes: 'original notes',
    });
    assert.equal(created.status, 201);

    await server.request('GET', `/reports/calls?from=2026-08-01&to=2026-08-31&tradeId=${plumbing.id}`);
    await server.request('GET', `/reports/calls/drilldown?from=2026-08-01&to=2026-08-31&metric=leadsByTrade&category=Plumbing`);

    const stillThere = (await server.request('GET', '/calls')).data.find((c) => c.id === created.data.id);
    assert.equal(stillThere.notes, 'original notes', 'the call record itself is untouched by reading the new report figures');
  } finally {
    server.close();
  }
});
