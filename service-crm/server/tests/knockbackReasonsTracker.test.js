import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun } from '../src/db/index.js';

// Knockback Reasons tracker — its own report box with entirely independent
// filters from the Technician & Sales report (defaults to the whole company,
// no date limit). Scoped to the existing knockback_reason list (never
// created/changed by this feature), grouped by the same "genuine Actual
// Knockback" population already used elsewhere (a qualified job with no sale
// at the visit) — see services/reports.js's computeKnockbackReasonsReport().

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const electrical = bundle.trades.find((t) => t.name === 'Electrical');
  const reasons = bundle.lists.knockback_reason;
  const priceReason = reasons.find((r) => r.name === 'Price');
  const compareReason = reasons.find((r) => r.name === 'Wanted to compare quotes');
  const techA = (await server.request('POST', '/settings/technicians', { name: 'KBR Tech A' })).data;
  const techB = (await server.request('POST', '/settings/technicians', { name: 'KBR Tech B' })).data;
  return { plumbing, electrical, priceReason, compareReason, techA, techB, allReasons: reasons };
}

let jnCounter = 0;
function nextJn() {
  jnCounter += 1;
  return `JN-KBRT-${jnCounter}`;
}

async function knockback(server, { technicianId, visitDate, tradeId, jobTypeId, knockbackReasonId, jobNumber }) {
  const res = await server.request('POST', '/tech/new-job', {
    kind: 'new_job_no_sale',
    visitDate,
    technicianId,
    jobNumber: jobNumber || nextJn(),
    tradeId,
    jobTypeId,
    lead: 'Qualified',
    knockbackReasonId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.entry;
}

test('Defaults to the whole company: counts and percentages across all reasons, no filters applied', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, compareReason, techA, techB } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-02', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techB.id, visitDate: '2026-05-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId: compareReason.id });

    const res = await server.request('GET', '/reports/tech/knockback-reasons');
    assert.equal(res.status, 200);
    assert.equal(res.data.total, 3);
    const price = res.data.byReason.find((r) => r.name === 'Price');
    const compare = res.data.byReason.find((r) => r.name === 'Wanted to compare quotes');
    assert.equal(price.count, 2);
    assert.equal(price.percent, 67);
    assert.equal(compare.count, 1);
    assert.equal(compare.percent, 33);
  } finally {
    server.close();
  }
});

test('Technician filter narrows the tracker to that technician only', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, compareReason, techA, techB } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techB.id, visitDate: '2026-05-02', tradeId: plumbing.id, jobTypeId, knockbackReasonId: compareReason.id });

    const res = await server.request('GET', `/reports/tech/knockback-reasons?technicianId=${techA.id}`);
    assert.equal(res.data.total, 1);
    assert.equal(res.data.byReason.length, 1);
    assert.equal(res.data.byReason[0].name, 'Price');
    assert.equal(res.data.byReason[0].percent, 100);
  } finally {
    server.close();
  }
});

test('Trade filter narrows the tracker to that trade only', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, electrical, priceReason, techA } = await setup(server);
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-02', tradeId: electrical.id, jobTypeId: electrical.jobTypes[0].id, knockbackReasonId: priceReason.id });

    const res = await server.request('GET', `/reports/tech/knockback-reasons?tradeId=${electrical.id}`);
    assert.equal(res.data.total, 1);
  } finally {
    server.close();
  }
});

test('Reason filter narrows the tracker to that one reason (100%)', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, compareReason, techA } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-02', tradeId: plumbing.id, jobTypeId, knockbackReasonId: compareReason.id });

    const res = await server.request('GET', `/reports/tech/knockback-reasons?reasonId=${priceReason.id}`);
    assert.equal(res.data.total, 1);
    assert.equal(res.data.byReason.length, 1);
    assert.equal(res.data.byReason[0].name, 'Price');
    assert.equal(res.data.byReason[0].percent, 100);
  } finally {
    server.close();
  }
});

test('Date range filters by the knockback job\'s own visit date', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, techA } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-06-15', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });

    const res = await server.request('GET', '/reports/tech/knockback-reasons?from=2026-05-01&to=2026-05-31');
    assert.equal(res.data.total, 1);
  } finally {
    server.close();
  }
});

test('A legacy record with no reason saved is grouped as "Not recorded", never guessed or dropped', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, techA } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });

    // A legacy knock-back saved before Reason for Knockback was mandatory —
    // inserted directly, never through the now-guarded POST route.
    dbRun(
      `INSERT INTO jobs (job_number, visit_date, technician_id, trade_id, job_type_id, lead, had_sale_at_visit, knockback, knockback_reason_id)
       VALUES (?, ?, ?, ?, ?, 'Qualified', 0, 1, NULL)`,
      ['JN-KBRT-LEGACY', '2026-05-02', techA.id, plumbing.id, jobTypeId]
    );

    const res = await server.request('GET', '/reports/tech/knockback-reasons?from=2026-05-01&to=2026-05-31');
    assert.equal(res.data.total, 2, 'the legacy record is still counted, never silently dropped');
    const notRecorded = res.data.byReason.find((r) => r.name === 'Not recorded');
    assert.ok(notRecorded, '"Not recorded" bucket exists');
    assert.equal(notRecorded.count, 1);
    assert.equal(notRecorded.percent, 50);
  } finally {
    server.close();
  }
});

test("A knock-back's original reason stays attached and counted even after its quote is later approved; the separate Converted Later sale never appears as another knockback", async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, techA } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    const jn = 'JN-KBRT-FLIP';
    const job = await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id, jobNumber: jn });

    const qal = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: jn,
      newJobNumber: 'AROFLO-KBRT-FLIP',
      dateLogged: '2026-05-05',
      creditedTechnicianId: techA.id,
      invoiceNumber: 'INV-KBRT-FLIP',
      invoiceDate: '2026-05-05',
      saleValueExGst: 400,
    });
    assert.equal(qal.status, 201);

    // Sanity check: the permanent flip did fire for this job.
    const entries = (await server.request('GET', '/tech/entries')).data;
    const jobAfter = entries.find((e) => e.jobNumber === jn && e.kind === 'new_job_no_sale');
    assert.equal(jobAfter.convertedLater, true);

    const res = await server.request('GET', '/reports/tech/knockback-reasons?from=2026-05-01&to=2026-05-31');
    assert.equal(res.data.total, 1, 'the original job is still counted exactly once, under its original reason');
    assert.equal(res.data.byReason[0].name, 'Price');
    assert.equal(res.data.byReason[0].count, 1);

    const drill = (await server.request('GET', '/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=knockbackByReason&category=Price')).data;
    assert.equal(drill.count, 1);
    assert.equal(drill.rows[0].kind, 'new_job_no_sale');
    assert.equal(drill.rows[0].id, job.id);
    assert.ok(
      !drill.rows.some((r) => r.kind === 'quote_approved_later'),
      'the separate Converted Later sale must never appear in the knock-back reason drill-down'
    );
  } finally {
    server.close();
  }
});

test('Clicking a reason opens exactly the original knock-back records counted in that figure, matching the active filters', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, priceReason, compareReason, techA, techB } = await setup(server);
    const jobTypeId = plumbing.jobTypes[0].id;
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-01', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-02', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techB.id, visitDate: '2026-05-03', tradeId: plumbing.id, jobTypeId, knockbackReasonId: priceReason.id });
    await knockback(server, { technicianId: techA.id, visitDate: '2026-05-04', tradeId: plumbing.id, jobTypeId, knockbackReasonId: compareReason.id });

    // Unfiltered: all 3 "Price" knock-backs.
    const allPrice = (await server.request('GET', '/reports/tech/drilldown?metric=knockbackByReason&category=Price')).data;
    assert.equal(allPrice.count, 3);
    assert.ok(allPrice.rows.every((r) => r.kind === 'new_job_no_sale'));

    // Scoped to Tech A: only 2 of those 3.
    const techAPrice = (await server.request('GET', `/reports/tech/drilldown?metric=knockbackByReason&category=Price&technicianId=${techA.id}`)).data;
    assert.equal(techAPrice.count, 2);
  } finally {
    server.close();
  }
});

test('Does not create or change the existing knockback reason list', async () => {
  const server = await startTestServer();
  try {
    const { allReasons } = await setup(server);
    const before = allReasons.map((r) => r.name).sort();

    await server.request('GET', '/reports/tech/knockback-reasons');
    await server.request('GET', '/reports/tech/drilldown?metric=knockbackByReason&category=Price');

    const bundleAfter = (await server.request('GET', '/settings/bundle')).data;
    const after = bundleAfter.lists.knockback_reason.map((r) => r.name).sort();
    assert.deepEqual(after, before, 'the knockback reason list is completely unchanged');
  } finally {
    server.close();
  }
});
