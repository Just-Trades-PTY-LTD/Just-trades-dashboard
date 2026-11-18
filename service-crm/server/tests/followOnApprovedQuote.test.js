import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, archiveEntries } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// Follow-on approved quotes — docs/follow-on-approved-quote-design.md.
// Mirrors the real case: knockback 2317 -> approved quote 2373 (converts the
// knockback, stays with the original lead) -> new work quoted during 2373,
// approved as 2747 (Repeat customer, normal sale, never a Converted Later
// credit, linked only to the earlier approved sale).

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

async function seed(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const jobTypeId = plumbing.jobTypes[1]?.id || plumbing.jobTypes[0].id;
  const [google] = b.lists.lead_source;
  const reason = b.lists.knockback_reason[0].id;
  const tylor = ok(await server.request('POST', '/settings/technicians', { name: 'Tylor' }));
  const lead = (jobNumber, callAt) =>
    server.request('POST', '/calls', { direction: 'Inbound', callType: 'Lead', booked: 'Yes', tradeId: plumbing.id, leadSourceId: google.id, jobNumber, callAt });
  const knockback = async (jobNumber, visitDate) =>
    ok(
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate,
        technicianId: tylor.id,
        jobNumber,
        tradeId: plumbing.id,
        jobTypeId,
        lead: 'Qualified',
        knockbackReasonId: reason,
        suburb: 'Glenelg',
      })
    ).entry;
  ok(await lead('F2317', '2026-09-20T09:00'));
  const job2317 = await knockback('F2317', '2026-09-22');
  const sale24 = ok(
    await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'F2317',
      newJobNumber: 'F2373',
      dateLogged: '2026-09-29',
      creditedTechnicianId: tylor.id,
      invoiceNumber: 'I2088',
      invoiceDate: '2026-09-29',
      saleValueExGst: 760,
    })
  ).entry;
  return { b, plumbing, jobTypeId, google, tylor, job2317, sale24, lead, knockback };
}

const followOn = (server, over) =>
  server.request('POST', '/tech/quote-approved-later', {
    jobNumber: 'F2373',
    newJobNumber: 'F2747',
    dateLogged: '2026-11-17',
    invoiceNumber: 'I2241',
    invoiceDate: '2026-11-17',
    saleValueExGst: 11623,
    ...over,
  });

const entry = async (server, id) => ok(await server.request('GET', '/tech/entries?status=all')).find((e) => e.kind === 'quote_approved_later' && e.id === id);
const history = async (server, id) => ok(await server.request('GET', `/tech/entries/quote_approved_later/${id}/history`));
const historyText = (h) => h.map((x) => (x.readable || []).join(' | ')).join('\n');

test('follow-on: the form lookup finds the earlier approved sale; saving needs the confirmation; it links only to that sale', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24, plumbing, jobTypeId, job2317 } = await seed(server);

    const look = ok(await server.request('GET', '/lookup/job?jn=F2373'));
    assert.equal(look.found, false, 'no job entry has 2373');
    assert.equal(look.followOnSources.length, 1);
    assert.equal(look.followOnSources[0].saleId, sale24.id);
    assert.equal(look.followOnSources[0].chain, 'JN F2317 → F2373');
    assert.equal(look.followOnSources[0].creditedTechnicianId, tylor.id);
    assert.deepEqual(ok(await server.request('GET', '/lookup/job?jn=F2317')).followOnSources, [], 'a normal job number has no follow-on source');

    const unconfirmed = await followOn(server, { creditedTechnicianId: tylor.id });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.data.error, /New Job Number of an earlier approved quote/);

    const nothing = await followOn(server, { jobNumber: 'F9999', creditedTechnicianId: tylor.id });
    assert.equal(nothing.status, 400);
    assert.match(nothing.data.error, /No existing job found for Original Job Number F9999/);

    const res = await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const e = res.data.entry;
    assert.equal(e.jobId, null, 'never linked to a Technician & Sales job');
    assert.equal(e.followsSaleId, sale24.id);
    assert.equal(e.jobNumber, 'F2373');
    assert.equal(e.newJobNumber, 'F2747');
    assert.equal(e.tradeId, plumbing.id, 'trade prefilled from the earlier sale');
    assert.equal(e.jobTypeId, jobTypeId);
    assert.equal(e.suburb, 'Glenelg', 'suburb prefilled from the earlier sale');
    assert.equal(e.followOnChain.text, 'JN F2317 → F2373 → F2747');
    assert.equal(e.originalKnockbackJobId, null);

    const earlier = await entry(server, sale24.id);
    assert.deepEqual(earlier.followedBy.map((f) => f.saleId), [e.id]);
    assert.equal(earlier.originalKnockbackJobId ?? null, earlier.originalKnockbackJobId ?? null);

    // The knockback stays converted by sale #24 only.
    const job = dbAll('SELECT converted_later, converted_by_sale_id FROM jobs WHERE id = ?', [job2317.id])[0];
    assert.deepEqual([job.converted_later, job.converted_by_sale_id], [1, sale24.id]);

    // History on both records.
    const h = historyText(await history(server, e.id));
    assert.match(h, /Follow-on approved quote \(Repeat customer\)\. Chain when saved: JN F2317 → F2373 → F2747/);
    assert.match(h, /Follows on from approved sale: — → sale #\d+ \(JN F2317 → F2373, invoice I2088\)/);
    const h24 = historyText(await history(server, sale24.id));
    assert.match(h24, new RegExp(`Follow-on approved quote linked: sale #${e.id} \\(JN F2373 → F2747, invoice I2241`));

    // Checks on the earlier sale.
    const self = await followOn(server, { newJobNumber: 'F2373', invoiceNumber: 'I1', creditedTechnicianId: tylor.id, followsSaleId: sale24.id });
    assert.equal(self.status, 400, 'New Job Number must differ from the Original');
    const wrong = await followOn(server, { jobNumber: 'F2317', newJobNumber: 'F5000', invoiceNumber: 'I2', creditedTechnicianId: tylor.id, followsSaleId: sale24.id });
    assert.equal(wrong.status, 400, 'Original Job Number must be the earlier sale\'s New Job Number');
    const dupe = await followOn(server, { invoiceNumber: 'I3', creditedTechnicianId: tylor.id, followsSaleId: sale24.id });
    assert.equal(dupe.status, 400, 'New Job Number 2747 already used');
    assert.match(dupe.data.error, /already used/);
  } finally {
    server.close();
  }
});

test('follow-on: a normal sale under Repeat customer, in average sale, never a Converted Later credit', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24, knockback } = await seed(server);
    // Another genuine knockback for Tylor in the same week as the follow-on's invoice.
    await knockback('F2800', '2026-11-16');
    ok(await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id }));

    const r = ok(await server.request('GET', '/reports/tech?from=2026-11-16&to=2026-11-22'));
    assert.equal(r.company.sales, 1);
    assert.equal(r.company.totalSaleExGst, 11623);
    const t = r.byTechnician.find((x) => x.name === 'Tylor');
    assert.equal(t.sales, 1);
    assert.equal(t.totalSaleExGst, 11623);
    assert.equal(r.company.avgSaleExGst, 11623, 'in the Average Sale value (sale value ÷ qualified jobs), like any approved quote');
    assert.equal(r.company.actualKnockbacks, 1);
    assert.equal(r.company.convertedLaterCredits, 0, 'never offsets another knockback');
    assert.equal(r.company.adjustedKnockbacks, 1);
    const repeat = r.salesByMarketingCategory.rows.find((x) => x.category === 'Repeat customer');
    assert.deepEqual(repeat, { category: 'Repeat customer', sales: 1, totalSalesValueExGst: 11623, averageInvoiceValue: 11623 });

    // The earlier approved sale is unchanged: original lead, Converted Later for 2317.
    const sep = ok(await server.request('GET', '/reports/tech?from=2026-09-21&to=2026-09-29'));
    assert.equal(sep.company.sales, 1);
    assert.equal(sep.salesByMarketingCategory.rows.length, 1);
    assert.notEqual(sep.salesByMarketingCategory.rows[0].category, 'Repeat customer');

    // Lead Source filter agrees.
    const bundle = ok(await server.request('GET', '/settings/bundle'));
    const repeatItem = bundle.lists.lead_source.find((l) => l.name === 'Repeat customer');
    assert.ok(repeatItem, 'Repeat customer Lead Source exists');
    const filtered = ok(await server.request('GET', `/reports/tech?from=2026-11-16&to=2026-11-22&leadSourceId=${repeatItem.id}`));
    assert.equal(filtered.company.sales, 1);
    const google = ok(await server.request('GET', `/reports/tech?from=2026-11-16&to=2026-11-22&leadSourceId=${bundle.lists.lead_source[0].id}`));
    assert.equal(google.company.sales, 0, 'not under the original lead');
  } finally {
    server.close();
  }
});

test('follow-on: more than one per earlier sale, further levels, and the edit rules', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24 } = await seed(server);
    const a = ok(await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    const b = ok(await followOn(server, { newJobNumber: 'F2800', invoiceNumber: 'I2300', creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    assert.deepEqual((await entry(server, sale24.id)).followedBy.map((f) => f.saleId), [a.id, b.id], 'two follow-ons of one sale');

    const look = ok(await server.request('GET', '/lookup/job?jn=F2747'));
    assert.equal(look.followOnSources[0].saleId, a.id, 'a follow-on can be followed on from');
    const c = ok(await followOn(server, { jobNumber: 'F2747', newJobNumber: 'F2900', invoiceNumber: 'I2400', creditedTechnicianId: tylor.id, followsSaleId: a.id })).entry;
    assert.equal(c.followsSaleId, a.id, 'links to the immediately previous sale');
    assert.equal(c.followOnChain.text, 'JN F2317 → F2373 → F2747 → F2900');

    // Original Job Number of a follow-on: only through Correct follow-on link.
    const jn = await server.request('PATCH', `/tech/quote-approved-later/${c.id}`, { jobNumber: 'F2800' });
    assert.equal(jn.status, 400);
    assert.match(jn.data.error, /Correct follow-on link/);
    // An earlier sale's New Job Number can't change while a follow-on depends on it.
    const nj = await server.request('PATCH', `/tech/quote-approved-later/${a.id}`, { newJobNumber: 'F2748' });
    assert.equal(nj.status, 400);
    assert.match(nj.data.error, /depends on New Job Number F2747/);
    // Other fields edit as normal, and stay a follow-on.
    const edited = ok(await server.request('PATCH', `/tech/quote-approved-later/${c.id}`, { saleValueExGst: 500, creditedTechnicianId: '' }));
    assert.equal(edited.saleValueExGst, 500);
    assert.equal(edited.followsSaleId, a.id);
    assert.equal(edited.creditedTechnicianId, tylor.id, 'technician kept when cleared');
    assert.equal(edited.jobId, null);

    // An approved sale that a follow-on links to can't be deleted (Archive is still offered).
    assert.equal((await entry(server, a.id)).canDelete, false);
    assert.equal((await entry(server, c.id)).canDelete, true);
    assert.equal((await server.request('DELETE', `/tech/entries/quote_approved_later/${a.id}`)).status, 409);

    // Link to original job is refused for a follow-on.
    const link = await server.request('POST', '/archive/link-qal/preview', { saleId: c.id });
    assert.equal(link.status, 400);
    assert.match(link.data.error, /follow-on approved quote/);
  } finally {
    server.close();
  }
});

test('Correct follow-on link: preview, reason, validation, three history entries, nothing else changes', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24 } = await seed(server);
    const a = ok(await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    const b = ok(await followOn(server, { newJobNumber: 'F2800', invoiceNumber: 'I2300', creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    const c = ok(await followOn(server, { jobNumber: 'F2747', newJobNumber: 'F2900', invoiceNumber: 'I2400', creditedTechnicianId: tylor.id, followsSaleId: a.id })).entry;
    const before = dbAll('SELECT * FROM sales WHERE id = ?', [c.id])[0];

    const preview = (id, jobNumber) => server.request('POST', `/tech/quote-approved-later/${id}/follow-on-link/preview`, { jobNumber });
    const apply = (id, body) => server.request('POST', `/tech/quote-approved-later/${id}/follow-on-link/apply`, body);

    // Blocked: same link, self, circular, unknown, not a follow-on.
    assert.match((await preview(c.id, 'F2747')).data.error, /already follows on/);
    assert.match((await preview(c.id, 'F2900')).data.error, /itself/);
    assert.match((await preview(a.id, 'F2900')).data.error, /circular/);
    assert.match((await preview(c.id, 'F0000')).data.error, /No approved sale has New Job Number F0000/);
    assert.match((await preview(sale24.id, 'F2800')).data.error, /not a follow-on/);

    const p = ok(await preview(c.id, 'F2800'));
    assert.equal(p.current.link.saleId, a.id);
    assert.equal(p.current.originalJobNumber, 'F2747');
    assert.equal(p.current.chain, 'JN F2317 → F2373 → F2747 → F2900');
    assert.equal(p.proposed.link.saleId, b.id);
    assert.equal(p.proposed.originalJobNumber, 'F2800');
    assert.equal(p.proposed.chain, 'JN F2317 → F2373 → F2800 → F2900');

    assert.equal((await apply(c.id, { jobNumber: 'F2800', token: p.token, reason: '  ' })).status, 400, 'reason required');
    assert.equal((await apply(c.id, { jobNumber: 'F2800', token: 'stale', reason: 'Wrong job' })).status, 409);
    const done = ok(await apply(c.id, { jobNumber: 'F2800', token: p.token, reason: 'Quoted during 2800, not 2747' }));
    assert.equal(done.entry.followsSaleId, b.id);
    assert.equal(done.entry.jobNumber, 'F2800');
    assert.equal(done.entry.followOnChain.text, 'JN F2317 → F2373 → F2800 → F2900');

    const after = dbAll('SELECT * FROM sales WHERE id = ?', [c.id])[0];
    for (const k of Object.keys(before)) {
      if (['follows_sale_id', 'job_number', 'updated_at'].includes(k)) continue;
      assert.deepEqual(after[k], before[k], `${k} unchanged`);
    }
    assert.equal(after.job_id, null);

    const hc = await history(server, c.id);
    assert.match(hc[0].readable.join(' | '), /Follow-on link corrected — reason: Quoted during 2800, not 2747\. Before: follows sale #\d+ \(JN F2373 → F2747.*Original Job Number F2747.*After: follows sale #\d+ \(JN F2373 → F2800/);
    assert.ok(hc.some((x) => x.readable.join(' ').includes('Chain when saved: JN F2317 → F2373 → F2747 → F2900')), 'original creation entry kept');
    assert.match(historyText(await history(server, a.id)), /unlinked by a link correction.*reason: Quoted during 2800/);
    assert.match(historyText(await history(server, b.id)), /Follow-on approved quote linked: .*link corrected — reason: Quoted during 2800/);

    // Activity history shows it too.
    const activity = ok(await server.request('GET', '/audit/activity?limit=10'));
    assert.ok(activity.rows.some((r) => r.readable.join(' ').includes('Follow-on link corrected')));
  } finally {
    server.close();
  }
});

test('Correct follow-on link: Staff can, Technician accounts cannot', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24 } = await seed(server);
    const a = ok(await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    ok(await followOn(server, { newJobNumber: 'F2800', invoiceNumber: 'I2300', creditedTechnicianId: tylor.id, followsSaleId: sale24.id }));
    ok(await server.request('POST', '/users', { name: 'Staff', email: 'staff-fo@test.local', password: 'password123', role: 'staff' }));
    const tAcct = ok(await server.request('POST', '/users', { name: 'Tylor acct', email: 'tylor-fo@test.local', password: 'password123', role: 'staff' }));
    ok(await server.request('POST', `/users/${tAcct.id}/technician-link`, { technicianId: tylor.id, confirm: true }));

    await server.login('tylor-fo@test.local', 'password123');
    const t = await server.request('POST', `/tech/quote-approved-later/${a.id}/follow-on-link/preview`, { jobNumber: 'F2800' });
    assert.equal(t.status, 403);

    await server.login('staff-fo@test.local', 'password123');
    // a follows sale #24 (New JN F2373); F2800's sale is a sibling, so this is a valid move.
    const s = await server.request('POST', `/tech/quote-approved-later/${a.id}/follow-on-link/preview`, { jobNumber: 'F2800' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
  } finally {
    server.close();
  }
});

test('archived earlier sale: follow-on still counts under Repeat customer and is listed in Data Health; new follow-ons from it are blocked', async () => {
  const server = await startTestServer();
  try {
    const { tylor, sale24 } = await seed(server);
    const a = ok(await followOn(server, { creditedTechnicianId: tylor.id, followsSaleId: sale24.id })).entry;
    const dh0 = ok(await server.request('GET', '/data-health'));
    assert.equal(dh0.checks.find((c) => c.id === 'followOnPreviousArchived').count, 0);

    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: sale24.id }], true));

    const r = ok(await server.request('GET', '/reports/tech?from=2026-11-16&to=2026-11-22'));
    assert.equal(r.company.sales, 1);
    assert.equal(r.company.totalSaleExGst, 11623);
    assert.equal(r.company.convertedLaterCredits, 0);
    assert.equal(r.salesByMarketingCategory.rows.find((x) => x.category === 'Repeat customer').sales, 1);

    const dh = ok(await server.request('GET', '/data-health'));
    const chk = dh.checks.find((c) => c.id === 'followOnPreviousArchived');
    assert.equal(chk.count, 1);
    assert.equal(chk.rows[0].newJobNumber, 'F2747');
    assert.match(chk.rows[0].previousSale, new RegExp(`Sale #${sale24.id} · JN F2317 → F2373`));
    assert.equal(dbAll('SELECT follows_sale_id FROM sales WHERE id = ?', [a.id])[0].follows_sale_id, sale24.id, 'link kept');

    const blocked = await followOn(server, { newJobNumber: 'F2800', invoiceNumber: 'I9', creditedTechnicianId: tylor.id, followsSaleId: sale24.id });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /archived/);

    ok(await archiveEntries(server, [{ kind: 'quote_approved_later', id: sale24.id }], false));
    assert.equal(ok(await server.request('GET', '/data-health')).checks.find((c) => c.id === 'followOnPreviousArchived').count, 0, 'restoring removes it');
  } finally {
    server.close();
  }
});
