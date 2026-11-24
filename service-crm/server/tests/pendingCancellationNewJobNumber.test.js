import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { get as dbGet } from '../src/db/index.js';
import { crmInvoicesForJob } from '../src/services/pendingCancellation.js';

// A Pending Cancellation finds an approved quote by its New Job Number (the
// AroFlo job of the approved work, which staff usually type), and a follow-on
// approved quote only by its New Job Number. Typing the Original Job Number
// still works as before.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tylor = ok(await server.request('POST', '/settings/technicians', { name: 'Tylor' }));
  const [google] = b.lists.lead_source;
  const repeat = b.lists.lead_source.find((l) => l.name === 'Repeat customer');
  ok(await server.request('POST', '/calls', { direction: 'Inbound', callType: 'Lead', booked: 'Yes', tradeId: plumbing.id, leadSourceId: google.id, jobNumber: 'C2317', callAt: '2026-09-20T09:00' }));
  ok(
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-09-22', technicianId: tylor.id, jobNumber: 'C2317', tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified', knockbackReasonId: b.lists.knockback_reason[0].id,
    })
  );
  const qal = (over) =>
    server.request('POST', '/tech/quote-approved-later', { dateLogged: '2026-11-18', creditedTechnicianId: tylor.id, ...over });
  const sale24 = ok(await qal({ jobNumber: 'C2317', newJobNumber: 'C2373', invoiceNumber: 'I2088', invoiceDate: '2026-09-29', saleValueExGst: 760 })).entry;
  const follow = ok(await qal({ jobNumber: 'C2373', newJobNumber: 'C2747', invoiceNumber: 'I2241', invoiceDate: '2026-11-18', saleValueExGst: 11623, followsSaleId: sale24.id })).entry;
  return { b, tylor, google, repeat, sale24, follow };
}

test('Pending Cancellation lookups find an approved quote by its New Job Number; a follow-on only by its New Job Number', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24, follow } = await seed(server);
    const look = async (jn, forCancel = true) => ok(await server.request('GET', `/lookup/sale?jn=${jn}${forCancel ? '&for=cancellation' : ''}`));

    const f = await look('C2747');
    assert.equal(f.found, true);
    assert.deepEqual([f.invoiceNumber, f.saleValueExGst, f.creditedTechnicianId], ['I2241', 11623, tylor.id]);
    assert.equal((await look('C2373')).invoiceNumber, 'I2088', '2373 is sale #24\'s approved job, not the follow-on');
    assert.equal((await look('C2317')).invoiceNumber, 'I2088', 'the Original Job Number still works');
    assert.equal((await look('C2747', false)).found, false, 'the plain sale lookup (Upsells, Quote approved calls) is unchanged');

    assert.deepEqual(crmInvoicesForJob('C2747').map((i) => [i.invoiceNumber, i.saleId, i.crmValueExGst]), [['I2241', follow.id, 11623]]);
    assert.deepEqual(crmInvoicesForJob('C2373').map((i) => i.saleId), [sale24.id]);
    assert.deepEqual(crmInvoicesForJob('C2317').map((i) => i.saleId), [sale24.id]);
  } finally {
    server.close();
  }
});

test('a Pending Cancellation on a follow-on is linked to it, credited to its technician, and reports under Repeat customer', async () => {
  const server = await startTestServer();
  try {
    const { b, tylor, google, repeat, follow } = await seed(server);
    const call = ok(
      await server.request('POST', '/calls', {
        callAt: '2026-11-24T13:14', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation',
        jobNumber: 'C2747', cancellationReasonId: b.lists.pending_cancellation_reason?.[0]?.id,
      })
    );
    const pc = dbGet('SELECT pc.* FROM pending_cancellations pc JOIN calls c ON c.pending_cancellation_id = pc.id WHERE c.id = ?', [call.id]);
    assert.equal(pc.sale_id, follow.id);
    assert.equal(pc.credited_technician_id, tylor.id);

    const rep = (q) => server.request('GET', `/reports/tech?from=2026-11-01&to=2026-11-30${q}`);
    assert.equal(ok(await rep(`&leadSourceId=${repeat.id}`)).company.pendingCancellations, 1);
    assert.equal(ok(await rep(`&leadSourceId=${google.id}`)).company.pendingCancellations, 0);
  } finally {
    server.close();
  }
});
