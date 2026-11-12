import test from 'node:test';
import assert from 'node:assert/strict';
import { lostValueGuidance, selectInvoice, detailsToState } from '../../client/src/lib/pendingCancellationForm.js';

// Stage 5: Calls & Contacts -> Cancellation -> Pending Cancellation records
// the affected invoice and the lost value (ex GST). Information only: never
// changes a sale, its revenue or any report figure.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { all: dbAll, get: dbGet } = await import('../src/db/index.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
// AroFlo: JN 9700 has invoices 2181 (now lower: $4,000) and 2190; nothing else.
function fakeAroflo() {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    assert.equal(init?.method || 'GET', 'GET');
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: '9700' }] : [] });
    if (u.pathname === '/v2/invoices') {
      return jsonResponse(200, { items: [
        { id: 'INV-A', invoiceNumber: '2181', invoicedDateTime: '2026-05-03T00:00:00', totalAmountEx: 4000, status: 'APPROVED' },
        { id: 'INV-B', invoiceNumber: '2190', invoicedDateTime: '2026-05-08T00:00:00', totalAmountEx: 900, status: 'PROCESSED' },
      ] });
    }
    return jsonResponse(200, { items: [] });
  };
  return () => (global.fetch = original);
}

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const tech2 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
  // JN 9700: sale on invoice 2181 ($4,754) + a $246 Upsell on it, then a
  // LATER Quote Approved Later sale on invoice 2190 ($900).
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: tech.id, jobNumber: '9700', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: '2181.0', invoiceDate: '2026-05-03', saleValueExGst: 4754,
  }));
  ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: '9700', invoiceNumber: '2181.0', dateLogged: '2026-05-04', creditedTechnicianId: tech2.id, invoiceDate: '2026-05-03', saleValueExGst: 246 }));
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: '9700', newJobNumber: 'AF-1', dateLogged: '2026-05-08', creditedTechnicianId: tech.id, invoiceNumber: '2190', invoiceDate: '2026-05-08', saleValueExGst: 900 }));
  const reason = b.lists.pending_cancellation_reason?.[0]?.id;
  const pcCall = (over = {}) =>
    server.request('POST', '/calls', { callAt: '2026-05-10T09:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: '9700', cancellationReasonId: reason, ...over });
  const pcOf = (callId) => dbGet('SELECT pc.* FROM pending_cancellations pc JOIN calls c ON c.pending_cancellation_id = pc.id WHERE c.id = ?', [callId]);
  const history = async (pcId) => dbAll("SELECT changes_json FROM audit_log WHERE entity_type = 'pending_cancellation' AND entity_id = ? ORDER BY id", [pcId]).map((r) => JSON.parse(r.changes_json));
  return { tech, pcCall, pcOf, history };
}
const saleId = (inv, upsell = 0) => dbAll('SELECT id, invoice_number FROM sales WHERE is_upsell = ?', [upsell]).find((s) => s.invoice_number.replace(/\.0$/, '') === inv).id;
const details = (over = {}) => ({ invoiceNumber: '2181', invoiceDate: '2026-05-03', arofloInvoiceId: 'INV-A', arofloInvoiceValueExGst: 4000, arofloInvoiceStatus: 'APPROVED', arofloCapturedAt: '2026-05-10T00:00:00Z', lostValueExGst: 754, lostValueBasis: 'part_of_work', ...over });
const reports = async (server) => {
  const t = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
  const c = ok(await server.request('GET', '/reports/calls?from=2026-05-01&to=2026-05-31'));
  return JSON.stringify({ t, c });
};

test('existing-style Pending Cancellation (no details): "not recorded"; editing the call without the section changes nothing on it', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { pcCall, pcOf } = await setup(server);
    const call = ok(await pcCall());
    assert.equal(call.pendingCancellation.recorded, false);
    const before = pcOf(call.id);
    ok(await server.request('PATCH', `/calls/${call.id}`, { notes: 'customer rang again' }));
    const after = pcOf(call.id);
    for (const f of ['invoice_number', 'lost_value_ex_gst', 'lost_value_basis', 'original_sale_value_ex_gst', 'superseded_by_id']) assert.equal(after[f], before[f], f);
    assert.equal(after.lost_value_ex_gst, null);
    // Technician & Sales shows it read-only, pointing at the call.
    const entries = ok(await server.request('GET', '/tech/entries'));
    const list = Array.isArray(entries) ? entries : Object.values(entries).find(Array.isArray);
    assert.ok(Array.isArray(list), `entries shape: ${Object.keys(entries)}`);
    const e = list.find((x) => x.kind === 'pending_cancellation');
    assert.deepEqual([e.pendingCancellation.recorded, e.linkedCall.id], [false, call.id]);
  } finally {
    restore();
    server.close();
  }
});

test('invoice list: one entry per invoice, CRM value incl. Upsells, AroFlo value and status, never combined; GET only', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    await setup(server);
    const r = ok(await server.request('GET', '/aroflo/pending-cancellation-invoices?jn=9700'));
    assert.deepEqual(
      r.invoices.map((i) => [i.invoiceNumber, i.invoiceDate, i.crm?.valueExGst, i.crm?.upsellValueExGst, i.aroflo?.valueExGst, i.aroflo?.status]),
      [['2181', '2026-05-03', 5000, 246, 4000, 'APPROVED'], ['2190', '2026-05-08', 900, 0, 900, 'PROCESSED']]
    );
    assert.equal(r.arofloNote, null);
  } finally {
    restore();
    server.close();
  }
});

test('saving: links to the CRM sale for the chosen invoice (not the latest sale), CRM value from the CRM, all in Activity history; sales and reports unchanged', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { pcCall, pcOf, history } = await setup(server);
    const call = ok(await pcCall());
    const before = await reports(server);
    const salesBefore = JSON.stringify(dbAll('SELECT * FROM sales ORDER BY id'));
    assert.equal(pcOf(call.id).sale_id, saleId('2190'), 'today: the latest sale is guessed');
    const saved = ok(await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationDetails: details({ crmValueExGst: 1 }) }));
    const pc = pcOf(call.id);
    assert.equal(pc.sale_id, saleId('2181'), 'linked to the sale for the chosen invoice, never the Upsell');
    assert.deepEqual(
      [pc.invoice_number, pc.original_sale_value_ex_gst, pc.aroflo_invoice_value_ex_gst, pc.aroflo_invoice_status, pc.lost_value_ex_gst, pc.lost_value_basis],
      ['2181', 5000, 4000, 'APPROVED', 754, 'part_of_work'],
      'CRM value computed by the CRM (incl. the Upsell), not taken from the request'
    );
    assert.equal(saved.pendingCancellation.recorded, true);
    const h = await history(pc.id);
    const last = h[h.length - 1];
    assert.deepEqual([last.invoice_number.to, last.lost_value_ex_gst.to, last.lost_value_basis.to, last.sale_id.from, last.sale_id.to], ['2181', 754, 'part_of_work', saleId('2190'), saleId('2181')]);
    assert.equal(JSON.stringify(dbAll('SELECT * FROM sales ORDER BY id')), salesBefore, 'no sale changed');
    assert.equal(await reports(server), before, 'every report figure unchanged');

    // Invalid input: refused, nothing saved.
    const bad = await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationDetails: details({ lostValueExGst: -5 }), notes: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(pcOf(call.id).lost_value_ex_gst, 754);
    assert.equal((await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationDetails: details({ lostValueBasis: 'everything' }) })).status, 400);
    // No invoice: lost value can still be entered by staff; the sale link isn't guessed again.
    ok(await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationDetails: details({ invoiceNumber: '', lostValueExGst: 300 }) }));
    const none = pcOf(call.id);
    assert.deepEqual([none.invoice_number, none.original_sale_value_ex_gst, none.aroflo_invoice_value_ex_gst, none.lost_value_ex_gst, none.sale_id], ['', null, null, 300, saleId('2181')]);
  } finally {
    restore();
    server.close();
  }
});

test('supersede: a later entire-invoice cancellation needs confirmation, then supersedes the earlier partial one, which is kept unchanged', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { pcCall, pcOf, history } = await setup(server);
    const partialCall = ok(await pcCall({ callAt: '2026-05-10T09:00', pendingCancellationDetails: details({ lostValueExGst: 1000 }) }));
    const partial = pcOf(partialCall.id);

    const first = await pcCall({ callAt: '2026-05-12T09:00', pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000 }) });
    assert.equal(first.status, 409);
    assert.equal(
      first.data.needsConfirmation.message,
      'This invoice already has a cancellation entry for $1,000.00 ex GST. Saving this entire-invoice cancellation will supersede that entry for reporting. The earlier record will remain in history.'
    );
    assert.equal(dbAll('SELECT * FROM pending_cancellations').length, 1, 'nothing saved before confirming');

    const wholeCall = ok(await pcCall({ callAt: '2026-05-12T09:00', pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000, confirmed: true }) }));
    const whole = pcOf(wholeCall.id);
    const earlier = pcOf(partialCall.id);
    assert.equal(earlier.superseded_by_id, whole.id);
    const { superseded_by_id: _s, updated_at: _u1, ...earlierRest } = earlier;
    const { superseded_by_id: _p, updated_at: _u2, ...partialRest } = partial;
    assert.deepEqual(earlierRest, partialRest, 'the earlier record is kept exactly as it was');
    assert.deepEqual((await history(partial.id)).pop(), { superseded_by_id: { from: null, to: whole.id } }, 'recorded in its Activity history');
    const reread = ok(await server.request('GET', '/calls'));
    const rows = reread.rows || reread.calls || reread;
    assert.ok(rows.find((c) => c.id === partialCall.id).pendingCancellation.supersededById);
    assert.deepEqual(rows.find((c) => c.id === wholeCall.id).pendingCancellation.supersedes.map((x) => x.lostValueExGst), [1000]);

    // Re-saving the same values doesn't ask again.
    ok(await server.request('PATCH', `/calls/${wholeCall.id}`, { pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000 }) }));
    // Changing the later one to "Part of the work" releases the earlier one (recorded).
    ok(await server.request('PATCH', `/calls/${wholeCall.id}`, { pendingCancellationDetails: details({ lostValueBasis: 'part_of_work', lostValueExGst: 500, confirmed: true }) }));
    assert.equal(pcOf(partialCall.id).superseded_by_id, null);
    assert.deepEqual((await history(partial.id)).pop(), { superseded_by_id: { from: whole.id, to: null } });
  } finally {
    restore();
    server.close();
  }
});

test('other relationships warn and need the lost value confirmed (nothing superseded); deleting the superseding call releases the earlier record', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { pcCall, pcOf } = await setup(server);
    const a = ok(await pcCall({ pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000 }) }));
    const second = await pcCall({ callAt: '2026-05-11T09:00', pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000 }) });
    assert.equal(second.status, 409);
    assert.equal(second.data.needsConfirmation.kind, 'confirmLostValue');
    assert.match(second.data.needsConfirmation.message, /already has a cancellation entry: \$5,000\.00 ex GST \(Entire invoice cancelled, 2026-05-10\)\. Nothing will be superseded\./);
    const b = ok(await pcCall({ callAt: '2026-05-11T09:00', pendingCancellationDetails: details({ lostValueBasis: 'whole_sale', lostValueExGst: 5000, confirmed: true }) }));
    assert.deepEqual([pcOf(a.id).superseded_by_id, pcOf(b.id).superseded_by_id], [null, null]);

    // Delete the superseding call: the earlier partial is released, not deleted.
    const p = ok(await pcCall({ callAt: '2026-05-09T09:00', jobNumber: '9700', pendingCancellationDetails: details({ invoiceNumber: '2190', arofloInvoiceValueExGst: 900, lostValueExGst: 100, confirmed: true }) }));
    const w = ok(await pcCall({ callAt: '2026-05-13T09:00', pendingCancellationDetails: details({ invoiceNumber: '2190', arofloInvoiceValueExGst: 900, lostValueBasis: 'whole_sale', lostValueExGst: 900, confirmed: true }) }));
    assert.equal(pcOf(p.id).superseded_by_id, pcOf(w.id).id);
    ok(await server.request('PATCH', `/calls/${w.id}`, { callType: 'Not lead', cancellationType: '' }));
    assert.equal(pcOf(p.id).superseded_by_id, null);
    assert.equal(pcOf(p.id).lost_value_ex_gst, 100, 'earlier record still there');
  } finally {
    restore();
    server.close();
  }
});

test('lost value rules on the form: entire invoice fills only when clear; part of the work offers the difference; otherwise left for staff', () => {
  const inv = (crm, aro) => ({ key: '2181', invoiceNumber: '2181', invoiceDate: '2026-05-03', crm: crm === null ? null : { valueExGst: crm }, aroflo: aro === null ? null : { id: 'X', valueExGst: aro, status: 'APPROVED' } });
  const st = (i, basis) => ({ ...selectInvoice(detailsToState(null), i, 'now'), lostValueBasis: basis });
  assert.deepEqual(lostValueGuidance(st(inv(5000, 5000), 'whole_sale')), { fill: 5000, offer: null, text: 'CRM and AroFlo agree on $5,000.00 ex GST for this invoice.' });
  assert.equal(lostValueGuidance(st(inv(5000, 4000), 'whole_sale')).fill, null);
  assert.match(lostValueGuidance(st(inv(5000, 4000), 'whole_sale')).text, /CRM recorded \$5,000\.00 ex GST but AroFlo now shows \$4,000\.00 ex GST/);
  assert.equal(lostValueGuidance(st(inv(5000, null), 'whole_sale')).fill, null, 'one source only: not filled');
  assert.deepEqual(lostValueGuidance(st(inv(5000, 4000), 'part_of_work')), { fill: null, offer: 1000, text: 'CRM recorded $5,000.00 − AroFlo now $4,000.00 = $1,000.00 ex GST.' });
  assert.equal(lostValueGuidance(st(inv(5000, 5000), 'part_of_work')).offer, null);
  assert.equal(lostValueGuidance(st(inv(5000, 6000), 'part_of_work')).offer, null);
  assert.match(lostValueGuidance({ ...detailsToState(null), lostValueBasis: 'whole_sale' }).text, /No invoice selected/);
});
