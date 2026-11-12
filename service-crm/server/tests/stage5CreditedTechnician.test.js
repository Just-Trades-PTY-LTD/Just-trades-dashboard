import test from 'node:test';
import assert from 'node:assert/strict';
import { creditedTechnicianPlan, detailsToState, selectInvoice } from '../../client/src/lib/pendingCancellationForm.js';

// Stage 5 (final): Calls & Contacts is the single place a Pending
// Cancellation is maintained, including its Credited technician.
// Technician & Sales is read-only — the server refuses edits there.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { all: dbAll, get: dbGet } = await import('../src/db/index.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
function fakeAroflo() {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://mock.test') return original(url, init);
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: '9800' }] : [] });
    if (u.pathname === '/v2/invoices') {
      return jsonResponse(200, { items: [
        { id: 'A', invoiceNumber: '3001', invoicedDateTime: '2026-05-03T00:00:00', totalAmountEx: 2000, status: 'APPROVED' },
        { id: 'B', invoiceNumber: '3002', invoicedDateTime: '2026-05-08T00:00:00', totalAmountEx: 900, status: 'APPROVED' },
      ] });
    }
    return jsonResponse(200, { items: [] });
  };
  return () => (global.fetch = original);
}

// JN 9800: sold at the visit by Tech One (invoice 3001), then a LATER Quote
// Approved Later sale by Tech Two on a different invoice (3002).
async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const t1 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const t2 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
  const t3 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Three' }));
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: t1.id, jobNumber: '9800', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: '3001', invoiceDate: '2026-05-03', saleValueExGst: 2000,
  }));
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: '9800', newJobNumber: 'AF-9800', dateLogged: '2026-05-08', creditedTechnicianId: t2.id, invoiceNumber: '3002', invoiceDate: '2026-05-08', saleValueExGst: 900 }));
  const reason = b.lists.pending_cancellation_reason?.[0]?.id;
  const call = ok(await server.request('POST', '/calls', { callAt: '2026-05-10T09:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: '9800', cancellationReasonId: reason, notes: 'customer cancelled' }));
  const pcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [call.id]).p;
  return { t1, t2, t3, call, pcId };
}

test('Technician & Sales cannot create or edit a Pending Cancellation by direct server request; nothing changes', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { t3, pcId } = await setup(server);
    const before = dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]);
    const auditBefore = dbAll('SELECT COUNT(*) n FROM audit_log')[0].n;
    const patch = await server.request('PATCH', `/tech/pending-cancellations/${pcId}`, { creditedTechnicianId: t3.id, comments: 'changed', jobNumber: 'OTHER', reasonId: null });
    assert.equal(patch.status, 405);
    assert.match(patch.data.error, /only on their Calls & Contacts call/);
    const post = await server.request('POST', '/tech/pending-cancellations', { jobNumber: '9800', dateLogged: '2026-05-11' });
    assert.equal(post.status, 405);
    assert.deepEqual(dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]), before, 'unchanged');
    assert.equal(dbAll('SELECT COUNT(*) n FROM pending_cancellations')[0].n, 1, 'nothing created');
    assert.equal(dbAll('SELECT COUNT(*) n FROM audit_log')[0].n, auditBefore, 'nothing recorded');
  } finally {
    restore();
    server.close();
  }
});

test('Credited technician on the call: invoices carry each sale\'s technician; saved, changed and cleared only from the call; in Activity history', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { t1, t2, t3, call, pcId } = await setup(server);
    // Existing behaviour on creation is kept (no backfill / change on its own).
    assert.equal(dbGet('SELECT credited_technician_id t FROM pending_cancellations WHERE id = ?', [pcId]).t, t2.id, 'saved technician as created today (latest sale)');
    const list = ok(await server.request('GET', '/aroflo/pending-cancellation-invoices?jn=9800'));
    assert.deepEqual(list.invoices.map((i) => [i.invoiceNumber, i.crm.creditedTechnicianId, i.crm.creditedTechnicianName]), [['3001', t1.id, 'Tech One'], ['3002', t2.id, 'Tech Two']]);

    // An edit that doesn't send the field keeps the saved technician.
    ok(await server.request('PATCH', `/calls/${call.id}`, { notes: 'rang back' }));
    assert.equal(dbGet('SELECT credited_technician_id t FROM pending_cancellations WHERE id = ?', [pcId]).t, t2.id);
    // The call form shows it as saved.
    const rows = ok(await server.request('GET', '/calls'));
    const row = (rows.rows || rows.calls || rows).find((c) => c.id === call.id);
    assert.equal(row.pendingCancellation.creditedTechnicianId, t2.id);

    // Staff select invoice 3001 and the technician from its sale (Tech One).
    ok(await server.request('PATCH', `/calls/${call.id}`, {
      pendingCancellationDetails: { invoiceNumber: '3001', arofloInvoiceValueExGst: 2000, lostValueExGst: 2000, lostValueBasis: 'whole_sale' },
      pendingCancellationCreditedTechnicianId: t1.id,
    }));
    const pc = dbGet('SELECT * FROM pending_cancellations WHERE id = ?', [pcId]);
    assert.deepEqual([pc.credited_technician_id, pc.sale_id], [t1.id, dbGet("SELECT id FROM sales WHERE invoice_number = '3001'").id]);
    // Staff correct it manually; then clear it (left for staff).
    ok(await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationCreditedTechnicianId: t3.id }));
    ok(await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationCreditedTechnicianId: null }));
    assert.equal(dbGet('SELECT credited_technician_id t FROM pending_cancellations WHERE id = ?', [pcId]).t, null);
    const hist = dbAll("SELECT changes_json FROM audit_log WHERE entity_type = 'pending_cancellation' AND entity_id = ? ORDER BY id", [pcId])
      .map((r) => JSON.parse(r.changes_json).credited_technician_id)
      .filter(Boolean);
    assert.deepEqual(hist.slice(-3), [{ from: t2.id, to: t1.id }, { from: t1.id, to: t3.id }, { from: t3.id, to: null }], 'every change in Activity history');
    assert.equal((await server.request('PATCH', `/calls/${call.id}`, { pendingCancellationCreditedTechnicianId: 999999 })).status, 400);
  } finally {
    restore();
    server.close();
  }
});

test('Technician & Sales entry carries every detail for the read-only view, including supersede links and the related call', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { t1, call, pcId } = await setup(server);
    ok(await server.request('PATCH', `/calls/${call.id}`, {
      pendingCancellationDetails: { invoiceNumber: '3001', arofloInvoiceValueExGst: 2000, arofloInvoiceStatus: 'APPROVED', lostValueExGst: 500, lostValueBasis: 'part_of_work' },
      pendingCancellationCreditedTechnicianId: t1.id,
    }));
    const later = ok(await server.request('POST', '/calls', {
      callAt: '2026-05-12T09:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: '9800',
      pendingCancellationDetails: { invoiceNumber: '3001', arofloInvoiceValueExGst: 2000, lostValueExGst: 2000, lostValueBasis: 'whole_sale', confirmed: true },
      pendingCancellationCreditedTechnicianId: t1.id,
    }));
    const entries = ok(await server.request('GET', '/tech/entries'));
    const e = entries.find((x) => x.kind === 'pending_cancellation' && x.id === pcId);
    assert.deepEqual(
      [e.jobNumber, e.dateShown, e.creditedTechnicianName, !!e.reasonName, e.comments, e.pendingCancellation.invoiceNumber, e.pendingCancellation.originalSaleValueExGst, e.pendingCancellation.arofloInvoiceValueExGst, e.pendingCancellation.arofloInvoiceStatus, e.pendingCancellation.lostValueExGst, e.pendingCancellation.lostValueBasis, e.linkedCall.id],
      ['9800', '2026-05-10', 'Tech One', true, 'customer cancelled', '3001', 2000, 2000, 'APPROVED', 500, 'part_of_work', call.id]
    );
    const laterPcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [later.id]).p;
    assert.deepEqual(e.pendingCancellation.supersededBy, { id: laterPcId, lostValueExGst: 2000, dateLogged: '2026-05-12' });
    const l = entries.find((x) => x.kind === 'pending_cancellation' && x.id === laterPcId);
    assert.deepEqual(l.pendingCancellation.supersedes, [{ id: pcId, lostValueExGst: 500, dateLogged: '2026-05-10' }]);
  } finally {
    restore();
    server.close();
  }
});

// The call form's Credited technician rule (pure).
const INVOICES = [
  { key: '3001', invoiceNumber: '3001', crm: { saleId: 1, creditedTechnicianId: 11, creditedTechnicianName: 'Tech One' }, aroflo: null },
  { key: '3002', invoiceNumber: '3002', crm: { saleId: 2, creditedTechnicianId: 22, creditedTechnicianName: 'Tech Two' }, aroflo: null },
  { key: '3003', invoiceNumber: '3003', crm: null, aroflo: { id: 'X', valueExGst: 100 } },
];
const state = (over = {}) => ({ ...detailsToState(null), ...over });
const pick = (invoiceNumber, over = {}) => ({ ...selectInvoice(state(over), INVOICES.find((i) => i.invoiceNumber === invoiceNumber), 'now') });

test('form rule: one sale and invoice -> filled from it; later QAL sale on another invoice -> the selected invoice\'s own sale, never the latest', () => {
  const one = creditedTechnicianPlan({ pc: state(), invoices: [INVOICES[0]], filled: null });
  assert.deepEqual([one.set, one.source.name], ['11', 'Tech One'], 'no invoice selected, exactly one sale');
  const p = creditedTechnicianPlan({ pc: pick('3001'), invoices: INVOICES, filled: null });
  assert.deepEqual([p.set, p.source.invoiceNumber], ['11', '3001'], 'original invoice -> Tech One, not the later QAL\'s Tech Two');
  assert.equal(creditedTechnicianPlan({ pc: pick('3002'), invoices: INVOICES, filled: null }).set, '22');
});

test('form rule: several possible sales or no reliable match -> left for staff', () => {
  const several = creditedTechnicianPlan({ pc: state(), invoices: INVOICES, filled: null });
  assert.equal(several.set, null);
  assert.match(several.note, /2 CRM sales — select the invoice, or choose the technician/);
  const noSale = creditedTechnicianPlan({ pc: pick('3003'), invoices: INVOICES, filled: null });
  assert.equal(noSale.set, null);
  assert.match(noSale.note, /isn't on a CRM sale/);
  assert.deepEqual(creditedTechnicianPlan({ pc: state(), invoices: null, filled: null }).set, null, 'invoices not looked up yet: nothing');
});

test('form rule: an existing saved or staff-chosen technician is never replaced — a different one is shown to choose', () => {
  const saved = creditedTechnicianPlan({ pc: pick('3001', { creditedTechnicianId: '22' }), invoices: INVOICES, filled: null });
  assert.equal(saved.set, null);
  assert.deepEqual(saved.difference, { id: '11', name: 'Tech One', invoiceNumber: '3001' });
  assert.equal(creditedTechnicianPlan({ pc: pick('3001', { creditedTechnicianId: '11' }), invoices: INVOICES, filled: null }).set, null, 'same: nothing to do');
});

test('form rule: changing the invoice replaces only the rule\'s own fill; a manual choice is kept', () => {
  // Auto-filled Tech One from 3001, then the invoice changes to 3002.
  let p = creditedTechnicianPlan({ pc: pick('3002', { creditedTechnicianId: '11' }), invoices: INVOICES, filled: '11' });
  assert.equal(p.set, '22', 'own fill follows the invoice');
  // To an invoice with no CRM sale: the own fill is cleared, left for staff.
  p = creditedTechnicianPlan({ pc: pick('3003', { creditedTechnicianId: '11' }), invoices: INVOICES, filled: '11' });
  assert.equal(p.set, '');
  // Staff had chosen Tech Three manually: kept, difference shown.
  p = creditedTechnicianPlan({ pc: pick('3002', { creditedTechnicianId: '33' }), invoices: INVOICES, filled: '11' });
  assert.deepEqual([p.set, p.difference?.name], [null, 'Tech Two']);
});

test('a new Pending Cancellation call saved with an invoice and technician: created with them directly (clean Activity history)', async () => {
  const server = await startTestServer();
  const restore = fakeAroflo();
  try {
    const { t1 } = await setup(server);
    const c = ok(await server.request('POST', '/calls', {
      callAt: '2026-05-11T09:00', direction: 'Inbound', callType: 'Cancellation', cancellationType: 'Pending Cancellation', jobNumber: '9800',
      pendingCancellationDetails: { invoiceNumber: '3001', arofloInvoiceValueExGst: 2000, lostValueExGst: 100, lostValueBasis: 'part_of_work' },
      pendingCancellationCreditedTechnicianId: t1.id,
    }));
    const pcId = dbGet('SELECT pending_cancellation_id p FROM calls WHERE id = ?', [c.id]).p;
    const [created, ...rest] = dbAll("SELECT changes_json FROM audit_log WHERE entity_type = 'pending_cancellation' AND entity_id = ? ORDER BY id", [pcId]).map((r) => JSON.parse(r.changes_json));
    const sale3001 = dbGet("SELECT id FROM sales WHERE invoice_number = '3001'").id;
    assert.deepEqual([created.sale_id.to, created.credited_technician_id.to], [sale3001, t1.id], 'created with the chosen sale and technician');
    assert.ok(rest.every((h) => !h.sale_id && !h.credited_technician_id), 'no second "guess then correct" entry');
  } finally {
    restore();
    server.close();
  }
});
