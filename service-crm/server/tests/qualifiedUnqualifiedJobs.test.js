import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './helpers.js';

test('Total Jobs includes qualified and unqualified jobs; Qualified/Unqualified Jobs count each correctly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-01',
      jobNumber: 'JN-QU-1',
      tradeId: plumbing.id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-02',
      jobNumber: 'JN-QU-2',
      tradeId: plumbing.id,
      lead: 'Not Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-03',
      jobNumber: 'JN-QU-3',
      tradeId: plumbing.id,
      lead: 'Not Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-08-01&to=2026-08-31')).data;
    assert.equal(report.company.jobsAttended, 3, 'Total Jobs includes every job, qualified and unqualified');
    assert.equal(report.company.qualifiedJobs, 1);
    assert.equal(report.company.unqualifiedJobs, 2);
  } finally {
    server.close();
  }
});

test('an unqualified no-sale job is never counted as a knock-back, and is excluded from Knock-back %, Conversion Rate and Average Sale', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    // 1 qualified knock-back + 1 qualified sale = 2 qualified jobs.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-10',
      jobNumber: 'JN-QU-4',
      tradeId: plumbing.id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-08-11',
      jobNumber: 'JN-QU-5',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-QU-5',
      invoiceDate: '2026-08-11',
      saleValueExGst: 1000,
    });
    // 2 unqualified no-sale jobs — must never be counted as knock-backs, and
    // must not affect the knock-back rate or conversion rate denominators.
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-12',
      jobNumber: 'JN-QU-6',
      tradeId: plumbing.id,
      lead: 'Not Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-08-13',
      jobNumber: 'JN-QU-7',
      tradeId: plumbing.id,
      lead: 'Not Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });

    const report = (await server.request('GET', '/reports/tech?from=2026-08-10&to=2026-08-31')).data;
    const { company } = report;

    assert.equal(company.jobsAttended, 4);
    assert.equal(company.qualifiedJobs, 2);
    assert.equal(company.unqualifiedJobs, 2);
    assert.equal(company.knockbacks, 1, 'only the 1 qualified no-sale job counts as a knock-back — the 2 unqualified ones never count');
    assert.equal(company.knockbackRate, 50, '1 knock-back / 2 qualified jobs = 50%, not / 4 total jobs');
    assert.equal(company.conversionRate, 50, '1 sale / 2 qualified jobs = 50%, not / 4 total jobs');
    assert.equal(company.avgSaleExGst, 500, '1000 / 2 qualified jobs = 500, not / 4 total jobs');
  } finally {
    server.close();
  }
});

// The `lead` column has no database-level constraint and predates being a
// required field on new entries — a legacy record can still have it blank.
// Simulated here with a direct DB insert since the API itself now requires
// a value on every new job.
test('a legacy job with no Lead classification at all is counted in Total Jobs but excluded from Qualified, Unqualified, and every qualified-scoped figure', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-09-01',
      jobNumber: 'JN-QU-8',
      tradeId: plumbing.id,
      lead: 'Qualified',
      invoiceNumber: 'INV-QU-8',
      invoiceDate: '2026-09-01',
      saleValueExGst: 400,
    });

    const db = new DatabaseSync(server.dbPath);
    db.prepare(
      `INSERT INTO jobs (job_number, visit_date, trade_id, lead, had_sale_at_visit)
       VALUES (?, ?, ?, '', 0)`
    ).run('JN-QU-9-LEGACY', '2026-09-02', plumbing.id);
    db.close();

    const report = (await server.request('GET', '/reports/tech?from=2026-09-01&to=2026-09-30')).data;
    const { company } = report;

    assert.equal(company.jobsAttended, 2, 'Total Jobs still counts the legacy blank-lead job');
    assert.equal(company.qualifiedJobs, 1, 'the blank-lead job is not counted as Qualified');
    assert.equal(company.unqualifiedJobs, 0, 'the blank-lead job is not counted as Unqualified either — it is left unclassified, not guessed');
    // Knock-back %, Conversion Rate and Average Sale are scoped to the 1
    // qualified job only; the blank-lead job (a no-sale, non-knock-back
    // job) must not appear in any of these denominators or counts.
    assert.equal(company.knockbacks, 0);
    assert.equal(company.conversionRate, 100, '1 sale / 1 qualified job = 100%, unaffected by the unclassified job');
    assert.equal(company.avgSaleExGst, 400, '400 / 1 qualified job, unaffected by the unclassified job');
  } finally {
    server.close();
  }
});

test('creating a New Job entry without a Lead value is rejected by the API', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const res = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-09-05',
      jobNumber: 'JN-QU-10',
      tradeId: plumbing.id,
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
      // lead intentionally omitted
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Please select whether this was a Qualified or Not Qualified lead before saving.');
  } finally {
    server.close();
  }
});
