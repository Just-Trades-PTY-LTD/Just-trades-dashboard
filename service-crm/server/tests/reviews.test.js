import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Reviews — a published (so far, always Google) review credited to one or
// more technicians. Entirely separate from Jobs/Sales/Knockbacks: these
// tests confirm (a) one review with several technicians never duplicates
// the company total while still crediting each technician once, (b)
// classification is always derived from the star rating, (c) the
// Technician & Sales report's own Positive Reviews figure is genuinely
// additive and never touches any existing job/sale/knockback/conversion
// figure, and (d) reading these figures never alters a stored record.

async function setup(server) {
  await server.login();
  const techA = (await server.request('POST', '/settings/technicians', { name: 'Review Tech A' })).data;
  const techB = (await server.request('POST', '/settings/technicians', { name: 'Review Tech B' })).data;
  return { techA, techB };
}

test('a review credited to two technicians counts once in the company total but once each for every technician', async () => {
  const server = await startTestServer();
  try {
    const { techA, techB } = await setup(server);
    const created = await server.request('POST', '/reviews', {
      reviewDate: '2026-05-01',
      rating: 5,
      technicianIds: [techA.id, techB.id],
      reviewLinkSent: 'Yes',
      jobNumber: 'JN-5001',
      notes: 'Great job all round.',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.classification, 'Positive');
    assert.equal(created.data.technicians.length, 2);

    const list = await server.request('GET', '/reviews');
    assert.equal(list.data.length, 1, 'the company list has exactly one review row, never duplicated per technician');

    const report = (await server.request('GET', '/reports/reviews?from=2026-05-01&to=2026-05-31')).data;
    assert.equal(report.kpis.total, 1, 'the company total counts the review once regardless of how many technicians it names');
    assert.equal(report.kpis.positive, 1);

    const byA = report.byTechnician.find((r) => r.name === 'Review Tech A');
    const byB = report.byTechnician.find((r) => r.name === 'Review Tech B');
    assert.equal(byA.total, 1, 'Technician A gets their own credit');
    assert.equal(byA.positive, 1);
    assert.equal(byB.total, 1, 'Technician B gets their own, separate credit — not duplicated, not skipped');
    assert.equal(byB.positive, 1);
  } finally {
    server.close();
  }
});

test('rating classification is always calculated from the star rating, never stored independently', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    const cases = [
      [5, 'Positive'],
      [4, 'Positive'],
      [3, 'Neutral'],
      [2, 'Negative'],
      [1, 'Negative'],
    ];
    for (const [rating, expected] of cases) {
      const res = await server.request('POST', '/reviews', {
        reviewDate: '2026-05-01',
        rating,
        technicianIds: [techA.id],
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.classification, expected, `a ${rating}-star review classifies as ${expected}`);
    }
  } finally {
    server.close();
  }
});

test('the Review Report KPIs and By Technician breakdown match a mixed set of reviews exactly', async () => {
  const server = await startTestServer();
  try {
    const { techA, techB } = await setup(server);
    // Tech A: one 5-star (Yes), one 2-star (No). Tech B: one 3-star (Yes).
    await server.request('POST', '/reviews', { reviewDate: '2026-06-01', rating: 5, technicianIds: [techA.id], reviewLinkSent: 'Yes' });
    await server.request('POST', '/reviews', { reviewDate: '2026-06-02', rating: 2, technicianIds: [techA.id], reviewLinkSent: 'No' });
    await server.request('POST', '/reviews', { reviewDate: '2026-06-03', rating: 3, technicianIds: [techB.id], reviewLinkSent: 'Yes' });

    const report = (await server.request('GET', '/reports/reviews?from=2026-06-01&to=2026-06-30')).data;
    assert.equal(report.kpis.total, 3);
    assert.equal(report.kpis.positive, 1);
    assert.equal(report.kpis.neutral, 1);
    assert.equal(report.kpis.negative, 1);
    assert.equal(report.kpis.avgRating, Math.round(((5 + 2 + 3) / 3) * 100) / 100);
    assert.equal(report.kpis.linkSentYes, 2);
    assert.equal(report.kpis.linkSentNo, 1);

    const byA = report.byTechnician.find((r) => r.name === 'Review Tech A');
    assert.equal(byA.total, 2);
    assert.equal(byA.positive, 1);
  } finally {
    server.close();
  }
});

test('a Review Report drill-down returns exactly the matching review records', async () => {
  const server = await startTestServer();
  try {
    const { techA, techB } = await setup(server);
    const positive = await server.request('POST', '/reviews', {
      reviewDate: '2026-06-10',
      rating: 5,
      technicianIds: [techA.id],
      reviewLinkSent: 'Yes',
    });
    const negative = await server.request('POST', '/reviews', { reviewDate: '2026-06-11', rating: 1, technicianIds: [techB.id] });

    const positiveDrill = (
      await server.request('GET', '/reports/reviews/drilldown?from=2026-06-01&to=2026-06-30&metric=positive')
    ).data;
    assert.equal(positiveDrill.count, 1);
    assert.equal(positiveDrill.rows[0].id, positive.data.id);
    assert.ok(!positiveDrill.rows.some((r) => r.id === negative.data.id));

    const byTechDrill = (
      await server.request(
        'GET',
        `/reports/reviews/drilldown?from=2026-06-01&to=2026-06-30&metric=reviewsByTechnician&scopeTechnician=${encodeURIComponent('Review Tech B')}`
      )
    ).data;
    assert.equal(byTechDrill.count, 1);
    assert.equal(byTechDrill.rows[0].id, negative.data.id);
  } finally {
    server.close();
  }
});

test('the Technician & Sales report shows Positive Reviews as a genuinely separate figure that never changes Total Jobs, Sales, Knockbacks or Conversion %', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-07-01',
      technicianId: techA.id,
      jobNumber: 'JN-REV-1',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      invoiceNumber: 'INV-REV-1',
      invoiceDate: '2026-07-01',
      saleValueExGst: 500,
    });

    const before = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;
    const beforeRow = before.byTechnician.find((r) => r.name === 'Review Tech A');
    assert.equal(beforeRow.positiveReviewsCount, 0, 'no reviews recorded yet');

    await server.request('POST', '/reviews', { reviewDate: '2026-07-02', rating: 5, technicianIds: [techA.id] });
    await server.request('POST', '/reviews', { reviewDate: '2026-07-03', rating: 2, technicianIds: [techA.id] });

    const after = (await server.request('GET', '/reports/tech?from=2026-07-01&to=2026-07-31')).data;
    const afterRow = after.byTechnician.find((r) => r.name === 'Review Tech A');

    // The only thing that may have changed is positiveReviewsCount — every
    // job/sale/knockback/conversion figure on this technician's row must be
    // byte-identical to before the reviews existed.
    assert.equal(afterRow.positiveReviewsCount, 1, 'only the 5-star review counts — the 2-star one is Negative');
    const { positiveReviewsCount: _beforeCount, ...beforeRest } = beforeRow;
    const { positiveReviewsCount: _afterCount, ...afterRest } = afterRow;
    assert.deepEqual(afterRest, beforeRest, 'every other figure on this technician row is completely unaffected by adding reviews');
    assert.deepEqual(before.company, after.company, 'company-wide job/sale/knockback figures are completely unaffected by adding reviews');

    // Its own drill-down (opened from this report's Positive Reviews column)
    // returns exactly that one positive review, via the Reviews kind of
    // drill-down, not the Tech one.
    const drill = (
      await server.request(
        'GET',
        `/reports/reviews/drilldown?from=2026-07-01&to=2026-07-31&metric=positiveReviewsByTechnician&scopeTechnician=${encodeURIComponent('Review Tech A')}`
      )
    ).data;
    assert.equal(drill.count, 1);
    assert.equal(drill.rows[0].rating, 5);
  } finally {
    server.close();
  }
});

test('editing a review updates its technician credit and last-edited info, without creating a duplicate or an orphaned link', async () => {
  const server = await startTestServer();
  try {
    const { techA, techB } = await setup(server);
    const created = await server.request('POST', '/reviews', { reviewDate: '2026-08-01', rating: 2, technicianIds: [techA.id] });
    assert.equal(created.data.lastEditedByName, 'Admin');

    const updated = await server.request('PATCH', `/reviews/${created.data.id}`, {
      rating: 5,
      technicianIds: [techB.id],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.classification, 'Positive');
    assert.equal(updated.data.technicians.length, 1);
    assert.equal(updated.data.technicians[0].name, 'Review Tech B');

    const report = (await server.request('GET', '/reports/reviews?from=2026-08-01&to=2026-08-31')).data;
    const byA = report.byTechnician.find((r) => r.name === 'Review Tech A');
    const byB = report.byTechnician.find((r) => r.name === 'Review Tech B');
    assert.ok(!byA, 'Technician A no longer has any credit — the old link was replaced, not left behind');
    assert.equal(byB.total, 1);
    assert.equal(byB.positive, 1);
    assert.equal(report.kpis.total, 1, 'editing never creates a second review row');
  } finally {
    server.close();
  }
});

test('a technician credited on a review cannot be permanently deleted, only deactivated', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    await server.request('POST', '/reviews', { reviewDate: '2026-08-05', rating: 4, technicianIds: [techA.id] });

    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const bundleTech = bundle.technicians.find((t) => t.id === techA.id);
    assert.equal(bundleTech.canDelete, false);

    const del = await server.request('DELETE', `/settings/technicians/${techA.id}`);
    assert.equal(del.status, 409);
  } finally {
    server.close();
  }
});

test('a drill-down row carries the same Entered By / Last Edited By info as the Review History list', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    await server.request('POST', '/reviews', { reviewDate: '2026-08-10', rating: 5, technicianIds: [techA.id] });

    const drill = (await server.request('GET', '/reports/reviews/drilldown?from=2026-08-01&to=2026-08-31&metric=total')).data;
    assert.equal(drill.rows[0].createdByName, 'Admin');
    assert.equal(drill.rows[0].lastEditedByName, 'Admin');
    assert.ok(drill.rows[0].updatedAt, 'updatedAt is a non-empty Adelaide-formatted timestamp, not blank');
  } finally {
    server.close();
  }
});

test('reading the Reviews report, its drill-down and its Excel export never alters a stored review', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    const created = await server.request('POST', '/reviews', {
      reviewDate: '2026-09-01',
      rating: 5,
      technicianIds: [techA.id],
      notes: 'original notes',
    });

    await server.request('GET', '/reports/reviews?from=2026-09-01&to=2026-09-30');
    await server.request('GET', '/reports/reviews/drilldown?from=2026-09-01&to=2026-09-30&metric=total');
    await server.request('GET', '/reports/reviews.xlsx?from=2026-09-01&to=2026-09-30');

    const stillThere = (await server.request('GET', '/reviews')).data.find((r) => r.id === created.data.id);
    assert.ok(stillThere);
    assert.equal(stillThere.notes, 'original notes');
    assert.equal(stillThere.rating, 5);
  } finally {
    server.close();
  }
});

test('the Reviews Excel export Summary and Records sheets match the filtered report exactly', async () => {
  const server = await startTestServer();
  try {
    const { techA } = await setup(server);
    await server.request('POST', '/reviews', { reviewDate: '2026-10-01', rating: 5, technicianIds: [techA.id], reviewLinkSent: 'Yes' });
    await server.request('POST', '/reviews', { reviewDate: '2026-10-02', rating: 3, technicianIds: [techA.id], reviewLinkSent: 'No' });

    const ExcelJS = (await import('exceljs')).default;
    const res = await server.rawGet('/reports/reviews.xlsx?from=2026-10-01&to=2026-10-31');
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);

    const summary = wb.getWorksheet('Summary');
    const summaryRows = summary.getSheetValues().filter(Boolean);
    const kpiRow = (label) => summaryRows.find((r) => r?.[1] === label);
    assert.equal(kpiRow('Total Reviews')[2], 2);
    assert.equal(kpiRow('Positive Reviews')[2], 1);
    assert.equal(kpiRow('Neutral Reviews')[2], 1);

    const records = wb.getWorksheet('Records');
    const recordRows = records.getSheetValues().filter(Boolean);
    // First non-empty row after the title block is the header; the rest are data.
    const headerIdx = recordRows.findIndex((r) => r?.[1] === 'Review Date');
    assert.equal(recordRows.length - headerIdx - 1, 2, 'exactly the 2 filtered reviews appear as records');
  } finally {
    server.close();
  }
});
