import test from 'node:test';
import assert from 'node:assert/strict';
import { existingInvoiceSuggestion, planSeparateInvoiceFill } from '../../client/src/lib/upsellForm.js';

// Stage 6: an Upsell on the original job's existing invoice (A) or on a
// separate invoice / AroFlo Job Number (B). Either way it reports under the
// original job; its own invoice / reference Job Number never change that.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');
const { get: dbGet } = await import('../src/db/index.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const [A, B] = b.lists.lead_source;
  const t1 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  const t2 = ok(await server.request('POST', '/settings/technicians', { name: 'Tech Two' }));
  // Original job 7700 (booked Lead call: source A), sold on invoice 5001 ($1,000).
  ok(await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: A.id, jobNumber: '7700', tradeId: plumbing.id }));
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-02', technicianId: t1.id, jobNumber: '7700', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: '5001', invoiceDate: '2026-05-02', saleValueExGst: 1000,
  }));
  // Another job's sale on invoice 5009 (for the "already recorded" refusal),
  // and a booked Lead call (source B) on what will be the separate JN 7799.
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-03', technicianId: t1.id, jobNumber: '7701', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: '5009', invoiceDate: '2026-05-03', saleValueExGst: 400,
  }));
  ok(await server.request('POST', '/calls', { callAt: '2026-05-04T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: B.id, jobNumber: '7799', tradeId: plumbing.id }));
  const upsell = (over) =>
    server.request('POST', '/tech/existing-job-upsell', { jobNumber: '7700', dateLogged: '2026-05-10', creditedTechnicianId: t2.id, invoiceDate: '2026-05-10', saleValueExGst: 300, ...over });
  return { A, B, t1, t2, plumbing, upsell };
}
const rowOf = (s, c) => s.rows.find((r) => r.category === c) || null;

test('(A) existing invoice: unchanged rules; (B) separate invoice: saved with its reference Job Number, refused if the invoice is already a CRM sale\'s, invoice date required', async () => {
  const server = await startTestServer();
  try {
    const { upsell } = await setup(server);
    const a = ok(await upsell({ invoiceNumber: '5001', saleValueExGst: 200 })).entry;
    assert.deepEqual([a.invoiceMode, a.newJobNumber], ['existing', '']);
    assert.equal((await upsell({ invoiceNumber: '5555' })).status, 400, 'existing mode still needs the invoice to be on record');

    const sep = ok(await upsell({ invoiceMode: 'separate', newJobNumber: ' 7799 ', invoiceNumber: '6001', saleValueExGst: 650 })).entry;
    assert.deepEqual([sep.invoiceMode, sep.newJobNumber, sep.invoiceNumber, sep.saleValueExGst], ['separate', '7799', '6001', 650]);
    assert.equal(dbGet('SELECT job_id FROM sales WHERE id = ?', [sep.id]).job_id, dbGet("SELECT id FROM jobs WHERE job_number = '7700'").id, 'linked to the original job');

    for (const inv of ['5001', '5009', '5009.0']) {
      const r = await upsell({ invoiceMode: 'separate', invoiceNumber: inv });
      assert.equal(r.status, 400, inv);
      assert.match(r.data.error, /already recorded on JN 770[01] \(Sale Made\), so it can't be used as a separate Upsell invoice/);
    }
    const noDate = await upsell({ invoiceMode: 'separate', invoiceNumber: '6002', invoiceDate: '' });
    assert.equal(noDate.status, 400);
    assert.match(noDate.data.error, /Invoice Date/);

    // A later Sale Made reusing the separate Upsell's invoice gets the heads-up.
    const reuse = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-05-12', technicianId: sep.creditedTechnicianId, jobNumber: '7702', tradeId: sep.tradeId, jobTypeId: sep.jobTypeId,
      lead: 'Qualified', invoiceNumber: '6001', invoiceDate: '2026-05-12', saleValueExGst: 650,
    });
    // Existing app rule: a duplicate invoice on a Sale Made is warned about
    // (not refused) — it now names the separate Upsell's job.
    assert.equal(reuse.status, 201);
    assert.match(reuse.data.notice, /invoice 6001 already exists on JN 7700/);
  } finally {
    server.close();
  }
});

test('edits: switching between existing and separate is re-checked; the reference Job Number is cleared for an existing-invoice Upsell; history records it', async () => {
  const server = await startTestServer();
  try {
    const { upsell } = await setup(server);
    const a = ok(await upsell({ invoiceNumber: '5001' })).entry;
    assert.equal((await server.request('PATCH', `/tech/existing-job-upsell/${a.id}`, { invoiceMode: 'separate' })).status, 400, 'its invoice 5001 is the sale\'s: refused');
    const moved = ok(await server.request('PATCH', `/tech/existing-job-upsell/${a.id}`, { invoiceMode: 'separate', invoiceNumber: '6003', newJobNumber: '7799' }));
    assert.deepEqual([moved.invoiceMode, moved.newJobNumber], ['separate', '7799']);
    const back = ok(await server.request('PATCH', `/tech/existing-job-upsell/${a.id}`, { invoiceMode: 'existing', invoiceNumber: '5001' }));
    assert.deepEqual([back.invoiceMode, back.newJobNumber], ['existing', '']);
    assert.equal((await server.request('PATCH', `/tech/existing-job-upsell/${a.id}`, { invoiceMode: 'existing', invoiceNumber: '6004' })).status, 400);
    const h = ok(await server.request('GET', `/tech/entries/existing_job_upsell/${a.id}/history`));
    assert.ok(h.some((x) => x.changes.new_job_number?.to === '7799'), 'reference Job Number change recorded');
  } finally {
    server.close();
  }
});

test('reporting: a separate-invoice Upsell stays under the original job\'s Lead Source (never the separate JN\'s own Lead call), adds value, never counts as a sale', async () => {
  const server = await startTestServer();
  try {
    const { A, B, upsell } = await setup(server);
    const before = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    ok(await upsell({ invoiceMode: 'separate', newJobNumber: '7799', invoiceNumber: '6001', saleValueExGst: 650 }));
    const after = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31'));
    assert.equal(rowOf(after.salesByMarketingCategory, A.name).totalSalesValueExGst, rowOf(before.salesByMarketingCategory, A.name).totalSalesValueExGst + 650);
    assert.equal(rowOf(after.salesByMarketingCategory, A.name).sales, rowOf(before.salesByMarketingCategory, A.name).sales, 'not counted as a sale');
    assert.equal(rowOf(after.salesByMarketingCategory, B.name), null, 'the separate JN\'s own Lead call is never used');
    assert.equal(after.company.sales, before.company.sales);
    assert.equal(after.company.upsellsCount, before.company.upsellsCount + 1);
  } finally {
    server.close();
  }
});

test('CRM recorded value on the existing invoice: sale + earlier Upsells, excluding the Upsell being edited', async () => {
  const server = await startTestServer();
  try {
    const { upsell } = await setup(server);
    assert.deepEqual(ok(await server.request('GET', '/lookup/upsell-invoice?jn=7700&invoice=5001')), { found: true, saleValueExGst: 1000, upsellValueExGst: 0, upsellCount: 0, recordedExGst: 1000 });
    const u = ok(await upsell({ invoiceNumber: '5001', saleValueExGst: 250 })).entry;
    assert.equal(ok(await server.request('GET', '/lookup/upsell-invoice?jn=7700&invoice=5001')).recordedExGst, 1250);
    assert.equal(ok(await server.request('GET', `/lookup/upsell-invoice?jn=7700&invoice=5001&excludeSaleId=${u.id}`)).recordedExGst, 1000);
    assert.deepEqual(ok(await server.request('GET', '/lookup/upsell-invoice?jn=7700&invoice=9999')), { found: false });
  } finally {
    server.close();
  }
});

test('AroFlo lookup: an invoice already used by a separate Upsell is flagged, so it\'s never filled into another sale', async () => {
  const server = await startTestServer();
  const original = global.fetch;
  try {
    const { upsell } = await setup(server);
    ok(await upsell({ invoiceMode: 'separate', newJobNumber: '7799', invoiceNumber: '6001', saleValueExGst: 650 }));
    global.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'http://mock.test') return original(url, init);
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 7799 }] : [] });
      if (u.pathname === '/v2/tasks/T1') return jsonResponse(200, { id: 'T1', jobNumber: 7799, status: 'COMPLETED', taskType: { name: '' }, locationText: '', client: { id: 'C1' } });
      if (u.pathname === '/v2/invoices') return jsonResponse(200, { items: [{ invoiceNumber: '6001', invoicedDateTime: '2026-05-10T00:00:00', totalAmountEx: 650, status: 'APPROVED', type: 'FINAL_INVOICE' }] });
      return jsonResponse(200, { items: [] });
    };
    const r = ok(await server.request('GET', '/aroflo/lookup?jn=7799'));
    assert.deepEqual([r.invoices[0].type, r.invoices[0].alreadyRecorded], ['FINAL_INVOICE', { jobNumber: '7700', kind: 'Upsell' }]);
  } finally {
    global.fetch = original;
    server.close();
  }
});

test('(A) suggestion: AroFlo\'s current total higher than the CRM\'s recorded sale + Upsells -> the difference with its calculation; otherwise none', () => {
  const crm = { found: true, saleValueExGst: 1000, upsellValueExGst: 200, upsellCount: 1, recordedExGst: 1200 };
  const aro = (v) => [{ invoiceNumber: '5001', saleValueExGst: v }];
  assert.deepEqual(existingInvoiceSuggestion({ arofloInvoices: aro(1650), invoiceNumber: '5001.0', crm }), {
    offer: 450,
    text: 'AroFlo invoice 5001.0 is now $1,650.00 − CRM recorded $1,200.00 (sale $1,000.00 + earlier Upsells $200.00) = $450.00 ex GST.',
  });
  assert.equal(existingInvoiceSuggestion({ arofloInvoices: aro(1200), invoiceNumber: '5001', crm }).offer, null);
  assert.match(existingInvoiceSuggestion({ arofloInvoices: aro(900), invoiceNumber: '5001', crm }).text, /not higher than the CRM's recorded \$1,200\.00/);
  assert.match(existingInvoiceSuggestion({ arofloInvoices: null, invoiceNumber: '5001', crm }).text, /Look up the original Job Number in AroFlo/);
  assert.equal(existingInvoiceSuggestion({ arofloInvoices: aro(1650), invoiceNumber: '', crm }), null);
});

test('(B) separate invoice: filled only from a single final / sales invoice not in the CRM; otherwise offered or explained', () => {
  const inv = (n, over = {}) => ({ invoiceNumber: n, invoiceDate: '2026-05-10', saleValueExGst: 650, status: 'APPROVED', type: 'FINAL_INVOICE', alreadyRecorded: null, ...over });
  const plan = (invoices) => planSeparateInvoiceFill({ result: { found: true, invoices }, jobNumber: '7799' });
  assert.deepEqual(plan([inv('6001')]).wanted, { invoiceNumber: '6001', invoiceDate: '2026-05-10', saleValueExGst: 650 });
  assert.deepEqual(plan([inv('6001', { type: 'SALES_INVOICE' })]).wanted.invoiceNumber, '6001');
  let p = plan([inv('6001', { type: 'PART_INVOICE' })]);
  assert.deepEqual([p.wanted, p.choices.length], [{}, 1]);
  assert.match(p.notes[0], /only invoice on JN 7799 is a part invoice, so it isn't filled in automatically/);
  p = plan([inv('6001', { alreadyRecorded: { jobNumber: '7700', kind: 'Sale Made' } })]);
  assert.deepEqual([p.wanted, p.choices.length], [{}, 0]);
  assert.match(p.notes[0], /already recorded on JN 7700 \(Sale Made\), so it can't be used/);
  p = plan([inv('6001'), inv('6002', { saleValueExGst: 90 })]);
  assert.deepEqual([p.wanted, p.choices.map((c) => c.invoiceNumber)], [{}, ['6001', '6002']]);
  assert.match(plan([]).notes[0], /no invoice on JN 7799 yet/);
  assert.match(planSeparateInvoiceFill({ result: { found: false, message: 'No matching AroFlo job found for "7799".' }, jobNumber: '7799' }).notes[0], /No matching AroFlo job/);
});
