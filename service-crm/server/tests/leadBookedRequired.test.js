import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun } from '../src/db/index.js';

const CONTACT_METHODS = ['Inbound', 'Outbound', 'Text Message', 'Email', 'Other / N/A'];

test('creating a Lead without Booked is rejected, across every Contact Method', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    for (const direction of CONTACT_METHODS) {
      const res = await server.request('POST', '/calls', { callAt: '2026-01-01T09:00:00', direction, callType: 'Lead', tradeId: plumbing.id });
      assert.equal(res.status, 400, `Lead via ${direction} without Booked should be rejected`);
      assert.equal(res.data.error, 'Please select whether this Lead was Booked before saving.');
    }
  } finally {
    server.close();
  }
});

test('creating a Lead with Booked answered succeeds, across every Contact Method', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    for (const direction of CONTACT_METHODS) {
      const res = await server.request('POST', '/calls', {
        callAt: '2026-01-01T09:00:00',
        direction,
        callType: 'Lead',
        tradeId: plumbing.id,
        booked: 'Yes',
      });
      assert.equal(res.status, 201, `Lead via ${direction} with Booked answered should succeed`);
      assert.equal(res.data.booked, 'Yes');
    }
  } finally {
    server.close();
  }
});

test('Booked stays optional for every non-Lead Call Type', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    for (const callType of ['Not lead', 'Quote approved', 'Call back', 'Cancellation']) {
      const res = await server.request('POST', '/calls', { callAt: '2026-01-01T09:00:00', direction: 'Inbound', callType, tradeId: plumbing.id });
      assert.equal(res.status, 201, `${callType} without Booked should still be accepted`);
    }
  } finally {
    server.close();
  }
});

test('Booked cannot be blank on an update while the record is a Lead', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/calls', {
      callAt: '2026-01-01T09:00:00',
      direction: 'Inbound',
      callType: 'Lead',
      tradeId: plumbing.id,
      booked: 'Yes',
    });
    assert.equal(created.status, 201);

    // Attempting to clear Booked back to blank on a still-Lead record must
    // be rejected — this is the "edited again" case, not just first save.
    const cleared = await server.request('PATCH', `/calls/${created.data.id}`, { booked: '' });
    assert.equal(cleared.status, 400);
    assert.equal(cleared.data.error, 'Please select whether this Lead was Booked before saving.');

    // The record itself must be unaffected by the rejected edit.
    const stillThere = await server.request('GET', '/calls');
    const found = stillThere.data.find((c) => c.id === created.data.id);
    assert.equal(found.booked, 'Yes', 'a rejected edit must not have altered the saved Booked value');
  } finally {
    server.close();
  }
});

test('editing a non-Lead call into a Lead requires Booked to be answered before it can save', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/calls', { callAt: '2026-01-01T09:00:00', direction: 'Inbound', callType: 'Not lead', tradeId: plumbing.id });
    assert.equal(created.status, 201);

    const switched = await server.request('PATCH', `/calls/${created.data.id}`, { callType: 'Lead' });
    assert.equal(switched.status, 400);
    assert.equal(switched.data.error, 'Please select whether this Lead was Booked before saving.');

    const switchedWithBooked = await server.request('PATCH', `/calls/${created.data.id}`, { callType: 'Lead', booked: 'No' });
    assert.equal(switchedWithBooked.status, 200);
    assert.equal(switchedWithBooked.data.booked, 'No');
  } finally {
    server.close();
  }
});

test('an existing Lead saved before this rule (Booked blank) remains viewable and editable on other fields without being forced to answer Booked first — but cannot be saved while still blank', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // Simulate a pre-existing record from before this validation existed —
    // a Lead call with Booked left blank, inserted directly like the old
    // data would already be on disk (never created through the now-guarded
    // POST route).
    const { lastInsertRowid } = dbRun(
      `INSERT INTO calls (call_at, direction, call_type, trade_id, booked, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2025-01-01T09:00:00', 'Inbound', 'Lead', plumbing.id, '', 'legacy record', 1]
    );

    const list = await server.request('GET', '/calls');
    assert.equal(list.status, 200);
    const legacy = list.data.find((c) => c.id === lastInsertRowid);
    assert.ok(legacy, 'the legacy record must still be viewable');
    assert.equal(legacy.booked, '', 'existing records must not have Booked silently backfilled');

    // Editing something unrelated while Booked is still blank must be
    // rejected until Booked is answered — it's still a Lead.
    const patchWithoutBooked = await server.request('PATCH', `/calls/${lastInsertRowid}`, { notes: 'updated notes' });
    assert.equal(patchWithoutBooked.status, 400);
    assert.equal(patchWithoutBooked.data.error, 'Please select whether this Lead was Booked before saving.');

    // Answering Booked lets the same edit go through.
    const patchWithBooked = await server.request('PATCH', `/calls/${lastInsertRowid}`, { notes: 'updated notes', booked: 'Yes' });
    assert.equal(patchWithBooked.status, 200);
    assert.equal(patchWithBooked.data.notes, 'updated notes');
    assert.equal(patchWithBooked.data.booked, 'Yes');
  } finally {
    server.close();
  }
});
