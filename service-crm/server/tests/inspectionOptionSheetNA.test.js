import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Inspection sheet / option sheet are plain text columns with no allowed-value
// constraint — adding "N/A" as a UI option needed no schema change, and any
// value the client sends round-trips through untouched.
test('inspection sheet and option sheet accept and save "N/A", not just Yes/No', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const created = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-01',
      technicianId: tech.id,
      jobNumber: 'JN-NA-1',
      tradeId: plumbing.id,
      lead: 'Qualified',
      inspectionSheet: 'N/A',
      optionSheet: 'N/A',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.entry.inspectionSheet, 'N/A');
    assert.equal(created.data.entry.optionSheet, 'N/A');

    // And it's editable back to Yes/No afterwards too, same as always.
    const patched = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, {
      inspectionSheet: 'Yes',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.inspectionSheet, 'Yes');
    assert.equal(patched.data.optionSheet, 'N/A', 'unrelated field left untouched by the patch');
  } finally {
    server.close();
  }
});

test('a job marked N/A on inspection/option sheet does not count as Yes in the completion rate', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Sam' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-07-05',
      technicianId: tech.id,
      jobNumber: 'JN-NA-2',
      tradeId: plumbing.id,
      lead: 'Qualified',
      inspectionSheet: 'N/A',
      optionSheet: 'Yes',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;
    // Existing behaviour, unchanged by this feature: only 'Yes' counts toward
    // completion — N/A currently reads the same as No. Documented here so a
    // future change to that semantic is a deliberate, visible decision.
    assert.equal(report.company.inspectionRate, 0);
    assert.equal(report.company.optionRate, 100);
  } finally {
    server.close();
  }
});
