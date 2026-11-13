import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run } from '../src/db/index.js';
import { findDuplicateInvoice, findSaleForInvoice, findDuplicateUpsell } from '../src/services/lookup.js';

// 39 live sales hold invoice numbers like "2227.0" (saved from AroFlo's
// numeric invoice numbers before 13 Nov). Staff type "2227": it must be the
// same invoice everywhere — never rewritten in the record. Found by the
// browser release check.
test('"2227" and a stored "2227.0" are the same invoice for Upsells and duplicate checks', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Dot Zero Tech' })).data;
    const upseller = (await server.request('POST', '/settings/technicians', { name: 'Dot Zero Upseller' })).data;
    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made', visitDate: '2026-11-10', technicianId: tech.id, jobNumber: '2767', tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified', invoiceNumber: '2227', invoiceDate: '2026-11-10', saleValueExGst: 500,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    // As the older live records were stored.
    run("UPDATE sales SET invoice_number = '2227.0' WHERE job_number = '2767'");

    assert.ok(findSaleForInvoice('2767', '2227'), 'Upsell finds the existing invoice');
    assert.ok(findDuplicateInvoice('2227'), 'duplicate-invoice warning still sees it');

    const up = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: '2767', invoiceNumber: '2227', dateLogged: '2026-11-13', creditedTechnicianId: upseller.id, invoiceDate: '2026-11-10', saleValueExGst: 100,
    });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.ok(findDuplicateUpsell('2767', '2227.0', upseller.id), 'the same Upsell typed either way is a duplicate');
    const again = await server.request('POST', '/tech/existing-job-upsell', {
      jobNumber: '2767', invoiceNumber: '2227.0', dateLogged: '2026-11-13', creditedTechnicianId: upseller.id, invoiceDate: '2026-11-10', saleValueExGst: 100,
    });
    assert.equal(again.status, 400, JSON.stringify(again.data));
    assert.match(again.data.error, /already has an Upsell/);
  } finally {
    server.close();
  }
});
