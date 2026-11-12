import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, archiveEntries } from './helpers.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';

// Stage 5: a Pending Cancellation with a linked call is archived, restored
// and deleted only through that call in Calls & Contacts.
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: tech.id, jobNumber: 'AC-1', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: 'INV-AC1', invoiceDate: '2026-05-03', saleValueExGst: 800,
  }));
  const call = ok(await server.request('POST', '/calls', { callAt: '2026-05-05T10:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: 'AC-1', cancellationReasonId: b.lists.pending_cancellation_reason?.[0]?.id }));
  const pcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [call.id]).p;
  return { b, plumbing, tech, call, pcId };
}
const entries = async (server, q = '') => ok(await server.request('GET', `/tech/entries${q}`));

test('Technician & Sales: no archive, restore or delete of a Pending Cancellation with a linked call — even by direct request; nothing changes', async () => {
  const server = await startTestServer();
  try {
    const { pcId } = await setup(server);
    const before = dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]);
    const auditBefore = dbAll('SELECT COUNT(*) n FROM audit_log')[0].n;
    const e = (await entries(server)).find((x) => x.kind === 'pending_cancellation');
    assert.deepEqual([e.managedByCall, e.canDelete], [true, false], 'actions hidden in the list');

    assert.equal((await archiveEntries(server, [{ kind: 'pending_cancellation', id: pcId }])).status, 405);
    // Straight to "apply" without a preview: refused too.
    const direct = await server.request('POST', '/archive/apply', { items: [{ kind: 'pending_cancellation', id: pcId }], archived: true, token: 'x' });
    assert.equal(direct.status, 405);
    const del = await server.request('DELETE', `/tech/entries/pending_cancellation/${pcId}`);
    assert.equal(del.status, 405);
    assert.match(del.data.error, /only through their linked call in Calls & Contacts/);
    assert.deepEqual(dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]), before, 'unchanged');
    assert.equal(dbAll('SELECT COUNT(*) n FROM audit_log')[0].n, auditBefore, 'nothing recorded');
  } finally {
    server.close();
  }
});

test('Calls & Contacts: archiving the call archives its cancellation (kept in history), restoring restores it; deleting the call deletes it', async () => {
  const server = await startTestServer();
  try {
    const { call, pcId } = await setup(server);
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }]));
    assert.equal(dbGet('SELECT archived FROM pending_cancellations WHERE id = ?', [pcId]).archived, 1);
    const archived = (await entries(server, '?status=all')).find((x) => x.kind === 'pending_cancellation' && x.id === pcId);
    assert.deepEqual([archived.archived, archived.jobNumber], [true, 'AC-1'], 'still listed in history as archived');
    assert.ok(dbAll("SELECT 1 FROM audit_log WHERE entity_type = 'pending_cancellation' AND entity_id = ?", [pcId]).length > 1, 'archive recorded in its history');
    ok(await archiveEntries(server, [{ kind: 'call', id: call.id }], false));
    assert.equal(dbGet('SELECT archived FROM pending_cancellations WHERE id = ?', [pcId]).archived, 0);
    ok(await server.request('DELETE', `/calls/${call.id}`));
    assert.equal(dbGet('SELECT COUNT(*) n FROM pending_cancellations WHERE id = ?', [pcId]).n, 0);
  } finally {
    server.close();
  }
});

test('other entry types keep Archive and Delete; a Pending Cancellation with no call at all keeps them (nowhere else to manage it)', async () => {
  const server = await startTestServer();
  try {
    const { b, plumbing, tech, call, pcId } = await setup(server);
    const job = ok(await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-05-06', technicianId: tech.id, jobNumber: 'AC-2', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified', knockbackReasonId: b.lists.knockback_reason[0].id,
    })).entry;
    const cb = ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'AC-1', visitDate: '2026-05-07', technicianId: tech.id, creditedTechnicianId: tech.id })).entry;
    const list = await entries(server);
    for (const [kind, id] of [['new_job_no_sale', job.id], ['call_back', cb.id]]) {
      const e = list.find((x) => x.kind === kind && x.id === id);
      assert.deepEqual([e.managedByCall ?? false, e.canDelete], [false, true], kind);
    }
    ok(await archiveEntries(server, [{ kind: 'call_back', id: cb.id }]));
    ok(await archiveEntries(server, [{ kind: 'call_back', id: cb.id }], false));
    assert.equal((await server.request('DELETE', `/tech/entries/new_job_no_sale/${job.id}`)).status, 200);

    // An old cancellation with no call (none exist in the 4 Nov backup).
    dbRun('UPDATE calls SET pending_cancellation_id = NULL WHERE id = ?', [call.id]);
    const orphan = (await entries(server)).find((x) => x.kind === 'pending_cancellation' && x.id === pcId);
    assert.deepEqual([orphan.managedByCall ?? false, orphan.canDelete], [false, true]);
    ok(await archiveEntries(server, [{ kind: 'pending_cancellation', id: pcId }]));
  } finally {
    server.close();
  }
});
