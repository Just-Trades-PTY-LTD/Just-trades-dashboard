import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('existing Inbound/Outbound calls are read back completely unchanged after this feature ships', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const inbound = (
      await server.request('POST', '/calls', {
        callAt: '2026-10-01T09:00:00',
        direction: 'Inbound',
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
      })
    ).data;
    const outbound = (
      await server.request('POST', '/calls', {
        callAt: '2026-10-02T09:00:00',
        direction: 'Outbound',
        callType: 'Call back',
        tradeId: plumbing.id,
      })
    ).data;

    const rows = (await server.request('GET', '/calls')).data;
    assert.equal(rows.find((r) => r.id === inbound.id).direction, 'Inbound', 'existing Inbound value preserved exactly');
    assert.equal(rows.find((r) => r.id === outbound.id).direction, 'Outbound', 'existing Outbound value preserved exactly');
  } finally {
    server.close();
  }
});

test('editing an existing call is never blocked by the new mandatory Contact Method / Call Type check', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = (
      await server.request('POST', '/calls', {
        callAt: '2026-10-03T09:00:00',
        direction: 'Inbound',
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
      })
    ).data;

    // A partial edit that doesn't touch direction/callType at all must work
    // exactly as before — the mandatory check only applies to creating a
    // brand-new call.
    const patched = await server.request('PATCH', `/calls/${created.id}`, { suburb: 'Newtown' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.direction, 'Inbound', 'unedited field stays exactly as it was');
    assert.equal(patched.data.suburb, 'Newtown');
  } finally {
    server.close();
  }
});

test('each new Contact Method (Text Message, Email, Other / N/A) can be saved and read back correctly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    for (const method of ['Text Message', 'Email', 'Other / N/A']) {
      const res = await server.request('POST', '/calls', {
        callAt: '2026-10-04T09:00:00',
        direction: method,
        callType: 'Not lead',
        tradeId: plumbing.id,
        jobNumber: `JN-CM-${method.replace(/[^A-Za-z]/g, '')}`,
      });
      assert.equal(res.status, 201, `creating a call with Contact Method "${method}" should succeed`);
      assert.equal(res.data.direction, method);
    }
  } finally {
    server.close();
  }
});

test('Lead Source and Contact Method are independent — setting one never affects the other', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const leadSource = bundle.lists.lead_source[0];

    const call = (
      await server.request('POST', '/calls', {
        callAt: '2026-10-05T09:00:00',
        direction: 'Text Message',
        callType: 'Lead',
        tradeId: plumbing.id,
        leadSourceId: leadSource.id,
        booked: 'Yes',
      })
    ).data;

    assert.equal(call.direction, 'Text Message', 'Contact Method records how they got in touch');
    assert.equal(call.leadSourceId, leadSource.id, 'Lead Source records where the customer found us, independently');
  } finally {
    server.close();
  }
});
