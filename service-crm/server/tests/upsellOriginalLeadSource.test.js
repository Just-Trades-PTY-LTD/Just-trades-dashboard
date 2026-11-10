import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';
import { planOriginalLeadSourceFill } from '../../client/src/lib/arofloPrefill.js';

// An Upsell never has a Marketing Category of its own. Reporting order:
// 1. original job in the CRM -> exactly that original job's category;
// 2. original job predates the CRM -> the original Job Number's booked Lead
//    call; otherwise the "Original job's Lead Source"; otherwise Unassigned.
// Its own invoice / any separate Job Number only identify and value it.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const NO_CALL = 'Unassigned (no booked Lead call)';
const report = async (server) => ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).salesByMarketingCategory;
const rowOf = (s, category) => s.rows.find((r) => r.category === category) || null;

async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const [A, B, C] = b.lists.lead_source;
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
  // A CRM job with a booked Lead call (source A) and its sale.
  ok(await server.request('POST', '/calls', { callAt: '2026-05-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: A.id, jobNumber: 'U-1', tradeId: plumbing.id }));
  ok(await server.request('POST', '/tech/new-job', {
    kind: 'new_job_sale_made', visitDate: '2026-05-02', technicianId: tech.id, jobNumber: 'U-1', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified', invoiceNumber: 'INV-U1', invoiceDate: '2026-05-02', saleValueExGst: 1000,
  }));
  // Another Job Number with a booked Lead call of a DIFFERENT source (B).
  ok(await server.request('POST', '/calls', { callAt: '2026-05-01T10:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: B.id, jobNumber: 'U-2', tradeId: plumbing.id }));
  const linked = ok(await server.request('POST', '/tech/existing-job-upsell', {
    jobNumber: 'U-1', invoiceNumber: 'INV-U1', dateLogged: '2026-05-05', creditedTechnicianId: tech.id, invoiceDate: '2026-05-05', saleValueExGst: 200,
    originalLeadSourceId: C.id, // ignored: a CRM-linked Upsell follows its original job
  })).entry;
  // JN 2084-style: original job predates the CRM, no booked Lead call.
  const preCrm = ok(await server.request('POST', '/tech/existing-job-upsell', {
    jobNumber: '2084', invoiceNumber: '2013', dateLogged: '2026-05-13', creditedTechnicianId: tech.id, tradeId: plumbing.id, invoiceDate: '2026-05-13', saleValueExGst: 964, predatesCrm: true,
  })).entry;
  return { A, B, C, tech, plumbing, linked, preCrm };
}

test('migration: the new column exists, starts empty for every sale, and nothing else changes', async () => {
  const server = await startTestServer();
  try {
    const { preCrm, linked } = await seed(server);
    const cols = dbAll('PRAGMA table_info(sales)').map((c) => c.name);
    assert.ok(cols.includes('original_lead_source_id'));
    assert.deepEqual(dbAll('SELECT original_lead_source_id FROM sales').map((r) => r.original_lead_source_id), [null, null, null]);
    assert.equal(preCrm.originalLeadSourceId, null);
    assert.equal(linked.originalLeadSourceId, null, 'CRM-linked Upsell never keeps one');
  } finally {
    server.close();
  }
});

test('JN 2084 before and after: Unassigned -> the saved Original job\'s Lead Source; counts and Total unchanged; history records it', async () => {
  const server = await startTestServer();
  try {
    const { A, B, C, preCrm } = await seed(server);
    const before = await report(server);
    assert.deepEqual(rowOf(before, NO_CALL), { category: NO_CALL, sales: 0, totalSalesValueExGst: 964, averageInvoiceValue: null });
    assert.equal(rowOf(before, C.name), null);

    const updated = ok(await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: C.id }));
    assert.deepEqual([updated.originalLeadSourceId, updated.originalLeadSourceName], [C.id, C.name]);
    const after = await report(server);
    assert.equal(rowOf(after, NO_CALL), null, 'Unassigned row gone');
    assert.deepEqual(rowOf(after, C.name), { category: C.name, sales: 0, totalSalesValueExGst: 964, averageInvoiceValue: null });
    assert.deepEqual(after.totals, before.totals, 'Total unchanged');
    assert.deepEqual(rowOf(after, A.name), rowOf(before, A.name));

    // The report's Lead Source filter follows the same rule.
    const filtered = ok(await server.request('GET', `/reports/tech?from=2026-05-01&to=2026-05-31&leadSourceId=${C.id}`)).salesByMarketingCategory;
    assert.deepEqual(filtered.rows.map((r) => [r.category, r.totalSalesValueExGst]), [[C.name, 964]]);

    // Activity history: the change, by name.
    const h = ok(await server.request('GET', `/tech/entries/existing_job_upsell/${preCrm.id}/history`));
    assert.deepEqual(h[0].changes.original_lead_source, { from: '', to: C.name });
    assert.deepEqual(Object.keys(h[0].changes), ['original_lead_source'], 'only the real change is recorded (no blank Date logged)');

    // Editing other fields keeps it; clearing it is recorded too.
    ok(await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { comments: 'note' }));
    assert.equal(dbGet('SELECT original_lead_source_id AS v FROM sales WHERE id = ?', [preCrm.id]).v, C.id);
    ok(await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: '' }));
    assert.equal(rowOf(await report(server), NO_CALL).totalSalesValueExGst, 964);
    const h2 = ok(await server.request('GET', `/tech/entries/existing_job_upsell/${preCrm.id}/history`));
    assert.deepEqual(h2[0].changes.original_lead_source, { from: C.name, to: '' });

    // An unknown Lead Source is refused and nothing changes.
    const bad = await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: 999999, comments: 'changed' });
    assert.equal(bad.status, 400);
    assert.equal(dbGet('SELECT comments FROM sales WHERE id = ?', [preCrm.id]).comments, 'note');
    // Not a Lead Source (another list's item) is refused too.
    const b = ok(await server.request('GET', '/settings/bundle'));
    assert.equal((await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: b.lists.knockback_reason[0].id })).status, 400);
    assert.ok(B);
  } finally {
    server.close();
  }
});

test('a booked Lead call on the original Job Number always wins over the Original job\'s Lead Source', async () => {
  const server = await startTestServer();
  try {
    const { B, C, preCrm, plumbing } = await seed(server);
    ok(await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: C.id }));
    ok(await server.request('POST', '/calls', { callAt: '2026-04-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: B.id, jobNumber: '2084', tradeId: plumbing.id }));
    const s = await report(server);
    assert.equal(rowOf(s, C.name), null);
    assert.equal(rowOf(s, B.name).totalSalesValueExGst, 964);
  } finally {
    server.close();
  }
});

test('CRM-linked Upsell: always the original job\'s category; its own invoice or Job Number never change it; the field is refused', async () => {
  const server = await startTestServer();
  try {
    const { A, B, C, linked } = await seed(server);
    let s = await report(server);
    assert.deepEqual(rowOf(s, A.name), { category: A.name, sales: 1, totalSalesValueExGst: 1200, averageInvoiceValue: 1000 });

    // Sending the field on an edit is ignored (stays NULL).
    ok(await server.request('PATCH', `/tech/existing-job-upsell/${linked.id}`, { originalLeadSourceId: C.id }));
    assert.equal(dbGet('SELECT original_lead_source_id AS v FROM sales WHERE id = ?', [linked.id]).v, null);

    // A separate invoice number, a separate (reference) Job Number, or even a
    // Job Number pointing at another booked Lead call (B) on the Upsell row
    // itself: the category still follows the linked original job (A).
    dbRun("UPDATE sales SET invoice_number = 'SEPARATE-INV', new_job_number = 'AF-SEPARATE', job_number = 'U-2' WHERE id = ?", [linked.id]);
    s = await report(server);
    assert.equal(rowOf(s, A.name).totalSalesValueExGst, 1200);
    assert.equal(rowOf(s, B.name), null);
  } finally {
    server.close();
  }
});

test('pre-CRM Upsell can be created with the field; a CRM-linked one created with it keeps none', async () => {
  const server = await startTestServer();
  try {
    const { C, tech, plumbing } = await seed(server);
    const e = ok(await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: '1999', invoiceNumber: '1900', dateLogged: '2026-05-20', creditedTechnicianId: tech.id, tradeId: plumbing.id, invoiceDate: '2026-05-20', saleValueExGst: 50, predatesCrm: true, originalLeadSourceId: C.id,
    })).entry;
    assert.equal(e.originalLeadSourceId, C.id);
    assert.equal(rowOf(await report(server), C.name).totalSalesValueExGst, 50);
    const h = ok(await server.request('GET', `/tech/entries/existing_job_upsell/${e.id}/history`));
    assert.deepEqual(h[0].changes.original_lead_source, { from: null, to: C.name });
  } finally {
    server.close();
  }
});

test('backup includes the field; restoring a backup from before it existed works (field empty)', async () => {
  const server = await startTestServer();
  try {
    const { C, preCrm } = await seed(server);
    ok(await server.request('PATCH', `/tech/existing-job-upsell/${preCrm.id}`, { originalLeadSourceId: C.id }));
    const backup = ok(await server.request('GET', '/export/backup.json'));
    assert.equal(backup.tables.sales.find((r) => r.id === preCrm.id).original_lead_source_id, C.id);

    // Round trip keeps it.
    ok(await server.request('POST', '/export/restore', backup));
    assert.equal(dbGet('SELECT original_lead_source_id AS v FROM sales WHERE id = ?', [preCrm.id]).v, C.id);

    // An older backup (no such column) restores with the field empty.
    const old = JSON.parse(JSON.stringify(backup));
    old.tables.sales.forEach((r) => delete r.original_lead_source_id);
    ok(await server.request('POST', '/export/restore', old));
    assert.equal(dbGet('SELECT original_lead_source_id AS v FROM sales WHERE id = ?', [preCrm.id]).v, null);
    assert.equal(dbAll('SELECT * FROM sales').length, backup.tables.sales.length);
  } finally {
    server.close();
  }
});

test('Upsell form prefill plan: one clear mapped AroFlo customer Lead Source fills a blank field only; otherwise a note', () => {
  const mapped = { found: true, leadSourceMatch: { kind: 'mapped', leadSourceId: 7, label: 'Flyer/Magnet', values: [{ field: 'Lead Source', value: 'Flyer' }] } };
  let p = planOriginalLeadSourceFill({ result: mapped, form: { originalLeadSourceId: '' } });
  assert.deepEqual(p.wanted, { originalLeadSourceId: '7' });
  assert.match(p.note, /"Flyer" → Flyer\/Magnet\. Filled in/);
  // A staff choice is never replaced — offered instead.
  p = planOriginalLeadSourceFill({ result: mapped, form: { originalLeadSourceId: '3' } });
  assert.deepEqual([p.wanted, p.suggestion], [{}, { leadSourceId: '7', label: 'Flyer/Magnet' }]);
  // What this lookup filled earlier can be replaced by a later lookup.
  p = planOriginalLeadSourceFill({ result: { ...mapped, leadSourceMatch: { ...mapped.leadSourceMatch, leadSourceId: 8, label: 'Google' } }, form: { originalLeadSourceId: '7' }, previousFilled: '7' });
  assert.deepEqual(p.wanted, { originalLeadSourceId: '8' });
  // Unmapped / conflict / none / not found: nothing filled.
  for (const m of [
    { kind: 'unmapped', values: [{ value: 'Online Ad' }] },
    { kind: 'conflict', values: [{ value: 'Google' }, { value: 'Flyer' }] },
    { kind: 'none', values: [] },
  ]) {
    p = planOriginalLeadSourceFill({ result: { found: true, leadSourceMatch: m }, form: { originalLeadSourceId: '' } });
    assert.deepEqual(p.wanted, {}, m.kind);
    assert.ok(p.note, m.kind);
  }
  assert.deepEqual(planOriginalLeadSourceFill({ result: { found: false }, form: { originalLeadSourceId: '' } }).wanted, {});
  // A booked Lead call exists: nothing to fill.
  assert.deepEqual(planOriginalLeadSourceFill({ result: mapped, form: { originalLeadSourceId: '' }, bookedLeadCall: { leadSource: 'Google' } }), { wanted: {}, note: null, suggestion: null });
});
