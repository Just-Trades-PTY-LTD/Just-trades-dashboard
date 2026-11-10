import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll } from '../src/db/index.js';
import { planNewJobPrefill, planQuoteApprovedLaterFill, applyPrefill, revertPrefill, prefillStep } from '../../client/src/lib/arofloPrefill.js';

// Stage 1: duplicate-invoice protection (Sale Made and Quote Approved Later)
// and the Quote Approved Later invoice from the NEW AroFlo Job Number. The
// original Job Number keeps supplying technician, Trade, Job type and Suburb
// (CRM); the new AroFlo job only supplies the invoice (blank fields, one
// clear invoice, not already on a CRM sale) — differing Trade / Job type is
// offered only. Nothing is saved by a lookup.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';
const { startTestServer } = await import('./helpers.js');

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

test('lookup marks an AroFlo invoice already recorded on a CRM sale — ".0" and case ignored; Upsells and archived sales don\'t count', async () => {
  const server = await startTestServer();
  const original = global.fetch;
  try {
    await server.login();
    const b = ok(await server.request('GET', '/settings/bundle'));
    const plumbing = b.trades.find((t) => t.name === 'Plumbing');
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
    ok(await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-11-03', technicianId: tech.id, jobNumber: '2600', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified', invoiceNumber: '2181.0', invoiceDate: '2026-11-03', saleValueExGst: 4754,
    }));
    global.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'http://mock.test') return original(url, init);
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 2700 }] : [] });
      if (u.pathname === '/v2/tasks/T1') return jsonResponse(200, { id: 'T1', jobNumber: 2700, status: 'COMPLETED', taskType: { name: '' }, locationText: '', client: { id: 'C1' } });
      if (u.pathname === '/v2/invoices') {
        return jsonResponse(200, { items: [{ invoiceNumber: '2181', invoicedDateTime: '2026-11-03T00:00:00', totalAmountEx: 4754, status: 'APPROVED' }, { invoiceNumber: '2190', invoicedDateTime: '2026-11-05T00:00:00', totalAmountEx: 900, status: 'APPROVED' }] });
      }
      return jsonResponse(200, { items: [] });
    };
    const before = dbAll('SELECT * FROM sales');
    const d = ok(await server.request('GET', '/aroflo/lookup?jn=2700'));
    assert.deepEqual(d.invoices.map((i) => [i.invoiceNumber, i.alreadyRecorded]), [['2181', { jobNumber: '2600', kind: 'Sale Made' }], ['2190', null]]);
    assert.deepEqual(dbAll('SELECT * FROM sales'), before, 'a lookup writes nothing');
  } finally {
    global.fetch = original;
    server.close();
  }
});

const now = { date: '2026-11-10', time: '09:00' };
const inv = (n, value = 500, extra = {}) => ({ invoiceNumber: n, invoiceDate: '2026-11-08', saleValueExGst: value, status: 'APPROVED', alreadyRecorded: null, ...extra });
const RECORDED = { jobNumber: '2600', kind: 'Sale Made' };

test('Sale Made prefill: a single AroFlo invoice already on a CRM sale is not filled — a clear note instead', () => {
  const form = { kind: 'new_job_sale_made', visitDate: '2026-11-08', suburb: '', comments: '', tradeId: '', jobTypeId: '', invoiceNumber: '', invoiceDate: '2026-11-10', saleValueExGst: '', workCompletion: '' };
  const base = { found: true, status: 'COMPLETED', suburb: null, invoices: [inv('2181', 4754, { alreadyRecorded: RECORDED })], activity: { visits: [], labour: [] } };
  const plan = planNewJobPrefill({ result: base, form, now, trades: [], technicians: [] });
  assert.ok(!('invoiceNumber' in plan.wanted) && !('saleValueExGst' in plan.wanted));
  assert.match(plan.notes.join(' '), /invoice 2181 is already recorded on JN 2600 \(Sale Made\), so it wasn't filled in/);
  const fresh = planNewJobPrefill({ result: { ...base, invoices: [inv('2190', 900)] }, form, now, trades: [], technicians: [] });
  assert.deepEqual([fresh.wanted.invoiceNumber, fresh.wanted.saleValueExGst], ['2190', 900], 'unchanged when not recorded');
});

const qalForm = (over = {}) => ({ kind: 'quote_approved_later', jobNumber: '2400', newJobNumber: '2700', tradeId: '3', jobTypeId: '31', suburb: 'Kilburn (5084)', comments: '', invoiceNumber: '', invoiceDate: '2026-11-10', saleValueExGst: '', ...over });
const found = (over = {}) => ({ found: true, invoices: [], taskTypeMatch: { kind: 'none' }, ...over });

test('Quote Approved Later: one invoice on the new Job Number fills number, date and value together — blank fields only', () => {
  const plan = planQuoteApprovedLaterFill({ result: found({ invoices: [inv('2190', 900)] }), form: qalForm() });
  assert.deepEqual(plan.wanted, { invoiceNumber: '2190', invoiceDate: '2026-11-08', saleValueExGst: 900 });
  const { patch, filled } = applyPrefill(qalForm(), {}, plan.wanted, { invoiceDate: '2026-11-10' });
  assert.deepEqual(patch, { invoiceNumber: '2190', invoiceDate: '2026-11-08', saleValueExGst: 900 }, "today's default invoice date counts as blank");
  // Staff already typed an invoice: nothing replaced (the three go together).
  const typed = applyPrefill(qalForm({ invoiceNumber: 'MINE' }), {}, plan.wanted, { invoiceDate: '2026-11-10' });
  assert.deepEqual(typed.patch, {});
  // A different new Job Number takes back exactly what was filled.
  assert.deepEqual(revertPrefill({ ...qalForm(), ...patch }, filled), { invoiceNumber: '', invoiceDate: '2026-11-10', saleValueExGst: '' });
  assert.deepEqual(revertPrefill({ ...qalForm(), ...patch, saleValueExGst: 950 }, filled), { invoiceNumber: '', invoiceDate: '2026-11-10' }, 'an edited value stays');
});

test('Quote Approved Later: recorded, several or no invoices; the original job\'s Trade / Job type kept, the new job\'s only offered', () => {
  let plan = planQuoteApprovedLaterFill({ result: found({ invoices: [inv('2181', 4754, { alreadyRecorded: RECORDED })] }), form: qalForm() });
  assert.deepEqual(plan.wanted, {});
  assert.match(plan.notes[0], /already recorded on JN 2600/);
  plan = planQuoteApprovedLaterFill({ result: found({ invoices: [inv('2190'), inv('2191')] }), form: qalForm() });
  assert.deepEqual([plan.wanted, plan.notes[0]], [{}, 'AroFlo has 2 invoices on the new Job Number — select the right one below, or none.']);
  plan = planQuoteApprovedLaterFill({ result: found(), form: qalForm() });
  assert.match(plan.notes[0], /No invoice on the new Job Number in AroFlo yet/);

  plan = planQuoteApprovedLaterFill({ result: found({ taskTypeMatch: { kind: 'full', tradeId: 3, jobTypeId: 32, label: 'Heating & Cooling — Installation' } }), form: qalForm() });
  assert.ok(!('tradeId' in plan.wanted) && !('jobTypeId' in plan.wanted), 'never replaced automatically');
  assert.deepEqual(plan.suggestions.map((s) => s.values), [{ tradeId: '3', jobTypeId: '32' }]);
  plan = planQuoteApprovedLaterFill({ result: found({ taskTypeMatch: { kind: 'full', tradeId: 3, jobTypeId: 31, label: 'same' } }), form: qalForm() });
  assert.equal(plan.suggestions.length, 0, 'same as the original job: nothing to offer');
  assert.ok(!('suburb' in plan.wanted) && !('creditedTechnicianId' in plan.wanted), 'Suburb and technician come from the original job only');
  // The original Job Number's own invoices are never used: the plan only reads the NEW Job Number's lookup result.
  const prefill = prefillStep({ result: found({ invoices: [inv('2190', 900)] }), form: { ...qalForm(), kind: 'new_job_sale_made' }, previous: {}, now, trades: [], technicians: [] });
  assert.ok(prefill.plan, 'Sale Made path unaffected');
});
