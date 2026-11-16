import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all } from '../src/db/index.js';
import { withReadableChanges, fieldLabel } from '../src/lib/auditDisplay.js';

test('Activity history shows names instead of raw IDs, without changing what is stored', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');
    const call = await server.request('POST', '/calls', { callAt: '2026-09-01T09:00', direction: 'Inbound', callType: 'Lead', tradeId: plumbing.id, jobNumber: '9811', booked: 'Yes' });
    assert.equal(call.status, 201);
    const storedBefore = all("SELECT id, changes_json FROM audit_log WHERE entity_type = 'call' ORDER BY id");
    await server.request('PATCH', `/calls/${call.data.id}`, { tradeId: electrical.id });

    const history = (await server.request('GET', `/calls/${call.data.id}/history`)).data;
    const edit = history[0];
    assert.deepEqual(edit.readable, ['Trade: Plumbing → Electrical']);
    assert.equal(String(edit.changes.trade_id.to), String(electrical.id), 'raw diff still returned unchanged');
    const created = history[history.length - 1];
    assert.ok(created.readable.includes('Trade: — → Plumbing'), created.readable.join(' | '));
    assert.ok(created.readable.includes('Job Number: — → 9811'));

    const activity = (await server.request('GET', '/audit/activity')).data;
    const row = activity.rows.find((r) => r.entityType === 'call' && r.action === 'edited');
    assert.deepEqual(row.readable, ['Trade: Plumbing → Electrical']);

    // Display only: the earlier stored rows are byte-for-byte unchanged.
    const storedAfter = all("SELECT id, changes_json FROM audit_log WHERE entity_type = 'call' ORDER BY id");
    assert.deepEqual(storedAfter.slice(0, storedBefore.length), storedBefore);
  } finally {
    server.close();
  }
});

test('deleted linked items, money, coded values and the AroFlo reference read safely', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Kurt' })).data;
    const [e] = withReadableChanges([
      {
        changes: {
          credited_technician_id: { from: 99999, to: tech.id },
          attending_technician_id: { from: null, to: '424242' },
          sale_value_ex_gst: { from: null, to: 3718 },
          knockback: { from: 0, to: 1 },
          lost_value_basis: { from: '', to: 'part_of_work' },
          aroflo_invoice_id: { from: '', to: 'JCQ6Kk8' },
          archived_with_job: { from: null, to: 77777 },
          converted_by_sale: { from: 88888, to: null },
          lead_source_id: { from: null, to: '55555' },
          visit_date: { from: null, to: '2026-11-02' },
        },
      },
    ]);
    assert.deepEqual(e.readable, [
      'Credited technician: Deleted technician (ID 99999) → Kurt',
      'Attending technician: — → Deleted technician (ID 424242)',
      'Sale value (ex GST): — → $3,718.00',
      'Knock-back: No → Yes',
      'Cancelled: — → Part of the work cancelled',
      'AroFlo invoice reference: recorded',
      'archived together with job Deleted job (ID 77777)',
      'no longer converted by Quote Approved Later sale Deleted sale (ID 88888)',
      'Lead Source: — → Deleted Lead Source (ID 55555)',
      'Visit date: — → 2026-11-02',
    ]);
    assert.ok(!e.readable.join(' ').includes('JCQ6Kk8'), "AroFlo's internal code is never shown");
    assert.equal(fieldLabel('some_new_field'), 'Some new field');
  } finally {
    server.close();
  }
});
