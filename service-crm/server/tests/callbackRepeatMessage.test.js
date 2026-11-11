import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { leadCallStatus } from '../../client/src/lib/leadCallStatus.js';

// The New Job form's Lead Source note for a callback Job Number must say what
// the report actually does: a job (and its sale) on a "Call back" call's Job
// Number, or on a Call Back entry's new callback Job Number, is Repeat
// customer. Read-only lookups.
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

test('callback Job Numbers: the form note and the report agree (Repeat customer); auto-fill from the call still works', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const b = ok(await server.request('GET', '/settings/bundle'));
    const plumbing = b.trades.find((t) => t.name === 'Plumbing');
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
    const newJob = (jobNumber, visitDate, extra = {}) =>
      server.request('POST', '/tech/new-job', {
        kind: 'new_job_sale_made', visitDate, technicianId: tech.id, jobNumber, tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Qualified', invoiceNumber: `INV-${jobNumber}`, invoiceDate: visitDate, saleValueExGst: 500, ...extra,
      });

    // 1. A "Call back" call on JN CB-1 (suburb recorded), then the callback job sold.
    ok(await server.request('POST', '/calls', { callAt: '2026-05-02T09:00', direction: 'Inbound', callType: 'Call back', jobNumber: 'CB-1', suburb: 'Kilburn (5084)', callBackReasonId: b.lists.callback_reason?.[0]?.id }));
    const look = ok(await server.request('GET', '/lookup/call?jn=CB-1'));
    assert.deepEqual(look.callback, { kind: 'callbackCall', callDate: '2026-05-02' });
    assert.equal(look.suburb, 'Kilburn (5084)', 'the call still auto-fills the suburb');
    assert.match(leadCallStatus('CB-1', look, '2026-05-04').text, /Repeat customer/);

    // 2. A Call Back entry with a new callback Job Number CB-NEW.
    ok(await newJob('ORIG-1', '2026-05-01'));
    ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'ORIG-1', newJobNumber: 'CB-NEW', visitDate: '2026-05-06', technicianId: tech.id, creditedTechnicianId: tech.id }));
    assert.deepEqual(ok(await server.request('GET', '/lookup/call?jn=CB-NEW')).callback, { kind: 'callbackEntry' });
    // The Call Back entry's ORIGINAL Job Number is not callback evidence.
    ok(await server.request('POST', '/calls', { callAt: '2026-05-03T09:00', direction: 'Inbound', callType: 'Call back', jobNumber: 'ORIG-1', callBackReasonId: b.lists.callback_reason?.[0]?.id }));
    assert.equal(ok(await server.request('GET', '/lookup/call?jn=ORIG-1')).callback, null);

    // The report agrees: both callback sales are Repeat customer.
    ok(await newJob('CB-1', '2026-05-04'));
    ok(await newJob('CB-NEW', '2026-05-06'));
    const rows = ok(await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).salesByMarketingCategory.rows;
    const repeat = rows.find((r) => r.category === 'Repeat customer');
    assert.deepEqual([repeat.sales, repeat.totalSalesValueExGst], [2, 1000]);
  } finally {
    server.close();
  }
});
